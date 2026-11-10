import { Effect, Path } from "effect";
import type { CallExpression, Node, SourceFile } from "typescript/unstable/ast";
import {
  isCallExpression,
  isExpressionStatement,
  isPropertyAccessExpression,
  isVoidExpression,
  isYieldExpression,
} from "typescript/unstable/ast/is";
import {
  ElementFlags,
  isErrorType,
  isObjectType,
  isStringMappingType,
  isTemplateLiteralType,
  isTupleType,
  isTypeReference,
  ObjectFlags,
  SignatureKind,
  TypeFlags,
} from "typescript/unstable/async";
import type { Checker, Type } from "typescript/unstable/async";

import { isUnderTestDirectory } from "../../../shared/classify-files-by-role.ts";
import {
  callsIn,
  CONCURRENT_TYPESCRIPT_REQUESTS,
  nodePosition,
  packageCalleesIn,
  packageFileOf,
  requiredTypeScriptRequest,
  resolvedSymbols,
  typeMembers,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import {
  outermostWrapperOf,
  pipedStepsOf,
  referencedNameOf,
  withoutWrappers,
} from "../../../shared/read-piped-steps-through-wrappers.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import { ForkFailureUnobserved, UnobservedForkFailuresRefused } from "./fork-failure-errors.ts";

const EFFECT_TYPE_ID = "~effect/Effect" satisfies keyof Effect.Effect<unknown>;
const FAILURE_VARIANCE = "_E";
const EFFECT_DECLARATION_FILE = "effect/dist/effect.d.ts";
const RUN_FORK = "runFork";
const RUN_FORK_WITH = "runForkWith";
const FIBER_FORKS: ReadonlySet<string> = new Set([RUN_FORK, RUN_FORK_WITH]);
const EFFECT_FORK_NAMES = ["forkChild", "forkScoped", "forkIn", "forkDetach"] as const;
const EFFECT_FORKS: ReadonlySet<string> = new Set(EFFECT_FORK_NAMES);
const BARE_FORKS: ReadonlySet<string> = new Set([RUN_FORK, ...EFFECT_FORK_NAMES]);
const FAILURE_HIDING_NAMES = ["exit", "result", "option"] as const;
const FAILURE_HIDING_STEPS: ReadonlySet<string> = new Set(FAILURE_HIDING_NAMES);
const VALUE_DISCARD_NAMES = ["asVoid", "as"] as const;
const VALUE_DISCARDS: ReadonlySet<string> = new Set(VALUE_DISCARD_NAMES);
const STEP_NAMES: ReadonlySet<string> = new Set([
  RUN_FORK,
  ...EFFECT_FORK_NAMES,
  ...FAILURE_HIDING_NAMES,
  ...VALUE_DISCARD_NAMES,
]);
const OPEN_TYPES =
  TypeFlags.TypeVariable |
  TypeFlags.Conditional |
  TypeFlags.Substitution |
  TypeFlags.Index |
  TypeFlags.Intersection;

const isSameNode = (left: Node, right: Node) => left.pos === right.pos && left.end === right.end;

const pipePositionOf = (node: Node) => {
  const outer = outermostWrapperOf(node);
  const { parent } = outer;
  const isReceiver = isPropertyAccessExpression(parent) && parent.expression === outer;
  const call = isReceiver ? parent.parent : parent;
  if (!isCallExpression(call)) {
    return;
  }
  const steps = pipedStepsOf(call);
  const index = steps?.findIndex((step) => isSameNode(step, outer)) ?? -1;
  const isPiped = steps !== undefined && index >= 0;
  return isPiped ? { pipe: call, steps, index } : undefined;
};

const isThrownAway = (value: Node) => {
  const { parent } = outermostWrapperOf(value);
  return isExpressionStatement(parent) || isVoidExpression(parent);
};

const isYieldedAndThrownAway = (value: Node) => {
  const { parent } = outermostWrapperOf(value);
  const isDelegated = isYieldExpression(parent) && parent.asteriskToken !== undefined;
  return isDelegated && isThrownAway(parent);
};

const argumentIndexOf = (call: CallExpression, node: Node) => {
  const outer = outermostWrapperOf(node);
  return call.arguments.findIndex((argument) => isSameNode(argument, outer));
};

const pipeStepInputs = (checker: Checker, pipe: CallExpression, step: Node) =>
  Effect.gen(function* () {
    const signature = yield* typeScriptRequest("resolve a pipe's signature", () =>
      checker.getResolvedSignature(pipe),
    );
    const stepType =
      signature === undefined
        ? undefined
        : yield* typeScriptRequest("read a pipe step's type", () =>
            checker.getParameterType(signature, argumentIndexOf(pipe, step)),
          );
    const stepSignatures =
      stepType === undefined
        ? []
        : yield* typeScriptRequest("read a pipe step's signatures", () =>
            checker.getSignaturesOfType(stepType, SignatureKind.Call),
          );
    const inputs = yield* Effect.forEach(stepSignatures, (stepSignature) =>
      typeScriptRequest("read a pipe step's input", () =>
        checker.getParameterType(stepSignature, 0),
      ),
    );
    return inputs.filter((input) => input !== undefined);
  });

const failuresOf = (checker: Checker, effect: Type) =>
  Effect.gen(function* () {
    const members = yield* typeMembers(effect);
    const failures = yield* Effect.forEach(members, (member) =>
      Effect.gen(function* () {
        const marker = yield* typeScriptRequest("read a type id", () =>
          checker.getPropertyOfType(member, EFFECT_TYPE_ID),
        );
        if (marker === undefined) {
          return [];
        }
        const markerType = yield* requiredTypeScriptRequest("read the type of a type id", () =>
          checker.getTypeOfSymbol(marker),
        );
        const variance = yield* typeScriptRequest("read a failure variance", () =>
          checker.getPropertyOfType(markerType, FAILURE_VARIANCE),
        );
        if (variance === undefined) {
          return [];
        }
        const varianceType = yield* requiredTypeScriptRequest(
          "read the type of a failure variance",
          () => checker.getTypeOfSymbol(variance),
        );
        const signatures = yield* typeScriptRequest("read the signature of a variance", () =>
          checker.getSignaturesOfType(varianceType, SignatureKind.Call),
        );
        return yield* Effect.forEach(signatures, (signature) =>
          requiredTypeScriptRequest("read the failure a variance holds", () =>
            checker.getReturnTypeOfSignature(signature),
          ),
        );
      }),
    );
    return failures.flat();
  });

const isOpen = (
  failure: Type,
): Effect.Effect<boolean, Effect.Error<ReturnType<typeof typeScriptRequest>>> =>
  Effect.gen(function* () {
    const isMapped = isObjectType(failure) && (failure.objectFlags & ObjectFlags.Mapped) !== 0;
    const isOpenByKind = (failure.flags & OPEN_TYPES) !== 0 || isMapped;
    if (isOpenByKind) {
      return true;
    }
    const tuple = isTypeReference(failure)
      ? yield* typeScriptRequest("read the type a reference refers to", () => failure.getTarget())
      : undefined;
    const isSpreadTuple =
      tuple !== undefined &&
      isTupleType(tuple) &&
      Array.isArray(tuple.elementFlags) &&
      tuple.elementFlags.some((flags) => (flags & ElementFlags.Variadic) !== 0);
    if (isSpreadTuple) {
      return true;
    }
    const templateParts = isTemplateLiteralType(failure)
      ? yield* typeScriptRequest("read the parts of a template type", () => failure.getTypes())
      : [];
    const mappedStrings = isStringMappingType(failure)
      ? [yield* typeScriptRequest("read the type a string mapping maps", () => failure.getTarget())]
      : [];
    const openParts = yield* Effect.forEach([...templateParts, ...mappedStrings], isOpen);
    return openParts.some(Boolean);
  });

const namedFailures = (checker: Checker, failureTypes: readonly Type[]) =>
  Effect.gen(function* () {
    const members = (yield* Effect.forEach(failureTypes, (failure) => typeMembers(failure))).flat();
    const isUnknown = members.some(
      (member) => (member.flags & TypeFlags.AnyOrUnknown) !== 0 || isErrorType(member),
    );
    if (isUnknown) {
      return [];
    }
    const failures = members.filter((member) => (member.flags & TypeFlags.Never) === 0);
    const openness = yield* Effect.forEach(failures, isOpen);
    const concreteFailures = failures.filter((_failure, index) => openness[index] !== true);
    const names = yield* Effect.forEach(concreteFailures, (failure) =>
      typeScriptRequest("name a failure type", () => checker.typeToString(failure)),
    );
    return [...new Set(names)].toSorted();
  });

const fileViolations = (
  checker: Checker,
  projectDirectory: string,
  sourceFile: SourceFile,
  displayName: string,
) =>
  Effect.gen(function* () {
    const callees = yield* packageCalleesIn(checker, projectDirectory, sourceFile);
    const operationOfCall = new Map(
      callees.flatMap(({ call, file, name, returnedBySignature }) =>
        file === EFFECT_DECLARATION_FILE ? [[call, { name, returnedBySignature }] as const] : [],
      ),
    );
    const bareSteps = callsIn(sourceFile)
      .flatMap((call) => pipedStepsOf(call)?.slice(1) ?? [])
      .map((step) => withoutWrappers(step))
      .filter((step) => !isCallExpression(step))
      .flatMap((step) => {
        const name = referencedNameOf(step);
        const isNamedLikeAStep = name !== undefined && STEP_NAMES.has(name.text);
        return isNamedLikeAStep ? [{ step, name }] : [];
      });
    const stepSymbols = yield* resolvedSymbols(
      checker,
      bareSteps.map(({ name }) => name),
    );
    const operationOfStep = new Map(
      bareSteps.flatMap(({ step }, index) => {
        const symbol = stepSymbols[index];
        const declaration = symbol?.declarations.at(0);
        const file =
          declaration === undefined ? undefined : packageFileOf(projectDirectory, declaration.path);
        const isEffectStep = symbol !== undefined && file === EFFECT_DECLARATION_FILE;
        return isEffectStep
          ? [[step, { name: symbol.name, returnedBySignature: false }] as const]
          : [];
      }),
    );
    const isOperation = (node: Node, names: ReadonlySet<string>) => {
      const value = withoutWrappers(node);
      const operation = isCallExpression(value)
        ? operationOfCall.get(value)
        : operationOfStep.get(value);
      return operation !== undefined && names.has(operation.name);
    };

    const typesAt = (node: Node) =>
      typeScriptRequest("read a forked effect's type", () => checker.getTypeAtLocation(node)).pipe(
        Effect.map((type) => (type === undefined ? [] : [type])),
      );

    const effectsBeforeHiding = (effect: Node) => {
      const value = withoutWrappers(effect);
      if (!isCallExpression(value)) {
        return typesAt(effect);
      }
      const steps = pipedStepsOf(value);
      const lastStep = steps?.at(-1);
      if (lastStep === undefined) {
        const [hidden] = value.arguments;
        const isHidingCall = hidden !== undefined && isOperation(value, FAILURE_HIDING_STEPS);
        return isHidingCall ? typesAt(hidden) : typesAt(effect);
      }
      const isHidingStep =
        steps !== undefined && steps.length > 1 && isOperation(lastStep, FAILURE_HIDING_STEPS);
      return isHidingStep ? pipeStepInputs(checker, value, lastStep) : typesAt(effect);
    };

    const forkedEffects = (fork: Node, input: Node | undefined) => {
      if (input !== undefined) {
        return effectsBeforeHiding(input);
      }
      const position = pipePositionOf(fork);
      const isStep = position !== undefined && position.index > 0;
      if (!isStep) {
        return Effect.succeed([]);
      }
      const stepBefore = position.steps.at(position.index - 1);
      if (stepBefore === undefined) {
        return Effect.succeed([]);
      }
      if (position.index === 1) {
        return effectsBeforeHiding(stepBefore);
      }
      return isOperation(stepBefore, FAILURE_HIDING_STEPS)
        ? pipeStepInputs(checker, position.pipe, stepBefore)
        : pipeStepInputs(checker, position.pipe, fork);
    };

    const isDropped = (fork: Node, name: string) => {
      const position = pipePositionOf(fork);
      const laterSteps = position?.steps.slice(position.index + 1) ?? [];
      const value = position?.pipe ?? fork;
      if (FIBER_FORKS.has(name)) {
        return laterSteps.length === 0 && isThrownAway(value);
      }
      const [nextStep] = laterSteps;
      const isFiberDiscarded = nextStep === undefined || isOperation(nextStep, VALUE_DISCARDS);
      return isFiberDiscarded && isYieldedAndThrownAway(value);
    };

    const forks = [
      ...[...operationOfCall].flatMap(([call, { name, returnedBySignature }]) => {
        const isFork = FIBER_FORKS.has(name) || EFFECT_FORKS.has(name);
        const position = pipePositionOf(call);
        const isStep = position !== undefined && position.index > 0;
        const isRunnerMade = name === RUN_FORK_WITH && !returnedBySignature;
        const takesOptions = FIBER_FORKS.has(name) && call.arguments.length !== 1;
        const isPipedRunFork = isStep && name === RUN_FORK;
        const isSkipped = !isFork || isPipedRunFork;
        if (isSkipped) {
          return [];
        }
        if (isStep) {
          return [{ fork: call, name, input: undefined }];
        }
        const curried = call.parent;
        const isCalledAtOnce =
          EFFECT_FORKS.has(name) &&
          isCallExpression(curried) &&
          curried.expression === call &&
          !operationOfCall.has(curried);
        if (isCalledAtOnce) {
          return [{ fork: curried, name, input: curried.arguments.at(0) }];
        }
        const isNotAFork = isRunnerMade || takesOptions;
        return isNotAFork ? [] : [{ fork: call, name, input: call.arguments.at(0) }];
      }),
      ...[...operationOfStep].flatMap(([step, { name }]) =>
        BARE_FORKS.has(name) ? [{ fork: step, name, input: undefined }] : [],
      ),
    ]
      .filter(({ fork, name }) => isDropped(fork, name))
      .toSorted((left, right) => left.fork.pos - right.fork.pos);

    const violations = yield* Effect.forEach(
      forks,
      ({ fork, name, input }) =>
        Effect.gen(function* () {
          const effects = yield* forkedEffects(fork, input);
          const failureTypes = yield* Effect.forEach(effects, (effect) =>
            failuresOf(checker, effect),
          );
          const [firstFailure, ...otherFailures] = yield* namedFailures(
            checker,
            failureTypes.flat(),
          );
          if (firstFailure === undefined) {
            return [];
          }
          const { line, column } = nodePosition(sourceFile, fork);
          return [
            new ForkFailureUnobserved({
              location: `${displayName}:${line}:${column}`,
              fork: `Effect.${name}`,
              failures: [firstFailure, ...otherFailures],
            }),
          ];
        }),
      { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
    );
    return violations.flat();
  });

export const findUnobservedForkFailures = <OpeningError, OpeningRequirement>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const projectDirectory = (yield* Path.Path).dirname(yield* absolutePathOf(projectFile));
    const violationsOfEachProject = yield* Effect.forEach(
      yield* openedProjects,
      ({ checker, sourceFiles }) =>
        Effect.forEach(
          sourceFiles.filter(({ displayName }) => !isUnderTestDirectory(displayName)),
          ({ sourceFile, displayName }) =>
            fileViolations(checker, projectDirectory, sourceFile, displayName),
          { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
        ),
    );
    const violations = violationsOfEachProject.flat().flat();
    if (violations.length > 0) {
      return yield* new UnobservedForkFailuresRefused({ violations });
    }
  });
