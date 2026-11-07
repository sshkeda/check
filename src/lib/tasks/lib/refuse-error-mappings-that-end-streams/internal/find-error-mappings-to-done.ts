import { Effect, Path } from "effect";
import type { Cause } from "effect";
import type { SourceFile } from "typescript/unstable/ast";
import { isArrayLiteralExpression, isStringLiteralLikeNode } from "typescript/unstable/ast/is";
import { SignatureKind } from "typescript/unstable/async";
import type { Checker, Type } from "typescript/unstable/async";

import {
  CONCURRENT_TYPESCRIPT_REQUESTS,
  nodePosition,
  packageCalleesIn,
  requiredTypeScriptRequest,
  typeMembers,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import { ErrorMappedToDone, ErrorMappingsRefused } from "./error-mapping-errors.ts";

const DONE_TYPE_ID = "~effect/Cause/Done" satisfies keyof Cause.Done;
const FAILURE_HANDLER = "onFailure";
const ERROR_MAPPINGS = new Set(["mapError", "mapErrorEager"]);
const BOTH_MAPPINGS = new Set(["mapBoth", "mapBothEager"]);
const RECOVERY_PREFIX = "catch";
const RESERVED_WORD_SUFFIX = /_$/u;
const FAILING_TYPE_IDS = ["~effect/Effect", "~effect/Stream"] as const;
const FAILURE_VARIANCE = "_E";
const MODULE_OF_DECLARATION_FILE = new Map([
  ["effect/dist/effect.d.ts", "Effect"],
  ["effect/dist/stream.d.ts", "Stream"],
  ["effect/dist/channel.d.ts", "Channel"],
  ["effect/dist/sink.d.ts", "Sink"],
]);

const canBeDone = (checker: Checker, type: Type) =>
  typeMembers(type).pipe(
    Effect.flatMap((members) =>
      Effect.forEach(members, (member) =>
        typeScriptRequest("read the Done type id", () =>
          checker.getPropertyOfType(member, DONE_TYPE_ID),
        ),
      ),
    ),
    Effect.map((properties) => properties.some((property) => property !== undefined)),
  );

const returnsDone = (checker: Checker, mapping: Type) =>
  Effect.gen(function* () {
    const signatures = yield* typeScriptRequest("read the mapping's signatures", () =>
      checker.getSignaturesOfType(mapping, SignatureKind.Call),
    );
    const returned = yield* Effect.forEach(signatures, (signature) =>
      requiredTypeScriptRequest("read the mapping's return type", () =>
        checker.getReturnTypeOfSignature(signature),
      ).pipe(Effect.flatMap((type) => canBeDone(checker, type))),
    );
    return returned.some(Boolean);
  });

const returnedTypesOf = (checker: Checker, callable: Type) =>
  Effect.gen(function* () {
    const signatures = yield* typeScriptRequest("read the handler's signatures", () =>
      checker.getSignaturesOfType(callable, SignatureKind.Call),
    );
    return yield* Effect.forEach(signatures, (signature) =>
      requiredTypeScriptRequest("read the handler's return type", () =>
        checker.getReturnTypeOfSignature(signature),
      ),
    );
  });

const failureTypesOf = (checker: Checker, failing: Type) =>
  Effect.gen(function* () {
    const variances = yield* Effect.forEach(FAILING_TYPE_IDS, (typeId) =>
      typeScriptRequest("read the variance of a failing type", () =>
        checker.getPropertyOfType(failing, typeId),
      ),
    );
    const failures = yield* Effect.forEach(
      variances.filter((variance) => variance !== undefined),
      (variance) =>
        Effect.gen(function* () {
          const varianceType = yield* requiredTypeScriptRequest("read a variance's type", () =>
            checker.getTypeOfSymbol(variance),
          );
          const failure = yield* typeScriptRequest("read the failure variance", () =>
            checker.getPropertyOfType(varianceType, FAILURE_VARIANCE),
          );
          if (failure === undefined) {
            return [];
          }
          const failureType = yield* requiredTypeScriptRequest("read the failure type", () =>
            checker.getTypeOfSymbol(failure),
          );
          return yield* returnedTypesOf(checker, failureType);
        }),
    );
    return failures.flat();
  });

const recoveryCanFailWithDone = (checker: Checker, handler: Type) =>
  Effect.gen(function* () {
    const recovered = (yield* returnedTypesOf(checker, handler)).map((returned) =>
      typeMembers(returned),
    );
    const failing = (yield* Effect.all(recovered)).flat();
    const failures = (yield* Effect.forEach(failing, (type) =>
      failureTypesOf(checker, type),
    )).flat();
    const doneFailures = yield* Effect.forEach(failures, (failure) => canBeDone(checker, failure));
    return doneFailures.some(Boolean);
  });

const handlersIn = (checker: Checker, argument: Type) =>
  Effect.gen(function* () {
    const properties = yield* typeScriptRequest("read the handlers of an object", () =>
      checker.getPropertiesOfType(argument),
    );
    const handlers = yield* Effect.forEach(properties, (property) =>
      typeScriptRequest("read a handler's type", () => checker.getTypeOfSymbol(property)),
    );
    return [argument, ...handlers.filter((handler) => handler !== undefined)];
  });

const recoveryFailsWithDone = (checker: Checker, argument: Type) =>
  Effect.gen(function* () {
    const handlers = yield* handlersIn(checker, argument);
    const failsWithDone = yield* Effect.forEach(handlers, (handler) =>
      recoveryCanFailWithDone(checker, handler),
    );
    return failsWithDone.some(Boolean);
  });

const failureMappingOf = (checker: Checker, argument: Type, name: string) =>
  Effect.gen(function* () {
    if (!BOTH_MAPPINGS.has(name)) {
      return argument;
    }
    const handler = yield* typeScriptRequest("read the onFailure handler", () =>
      checker.getPropertyOfType(argument, FAILURE_HANDLER),
    );
    return handler === undefined
      ? undefined
      : yield* typeScriptRequest("read the onFailure handler's type", () =>
          checker.getTypeOfSymbol(handler),
        );
  });

const fileViolations = (
  checker: Checker,
  projectDirectory: string,
  sourceFile: SourceFile,
  displayName: string,
) =>
  Effect.gen(function* () {
    const callees = yield* packageCalleesIn(checker, projectDirectory, sourceFile);
    const mappings = callees.flatMap(({ call, file, name }) => {
      const moduleName = MODULE_OF_DECLARATION_FILE.get(file);
      const isRecovery = name.startsWith(RECOVERY_PREFIX);
      const isMapping = ERROR_MAPPINGS.has(name) || BOTH_MAPPINGS.has(name) || isRecovery;
      const mapping = call.arguments.at(-1);
      const isEffectMapping = moduleName !== undefined && isMapping && mapping !== undefined;
      const handlers = isRecovery
        ? call.arguments.filter(
            (argument) => !isStringLiteralLikeNode(argument) && !isArrayLiteralExpression(argument),
          )
        : [];
      return isEffectMapping
        ? [
            {
              call,
              mapping,
              handlers,
              name,
              operation: `${moduleName}.${name.replace(RESERVED_WORD_SUFFIX, "")}`,
            },
          ]
        : [];
    });
    const violations = yield* Effect.forEach(
      mappings,
      ({ call, mapping, handlers, name, operation }) =>
        Effect.gen(function* () {
          const argument = yield* typeScriptRequest("read the mapping's type", () =>
            checker.getTypeAtLocation(mapping),
          );
          const handlerTypes = yield* typeScriptRequest("read the recovery handlers' types", () =>
            checker.getTypeAtLocation(handlers),
          );
          const failureMapping =
            argument === undefined ? undefined : yield* failureMappingOf(checker, argument, name);
          const mapsToDone =
            failureMapping !== undefined && (yield* returnsDone(checker, failureMapping));
          const recoveries = yield* Effect.forEach(
            handlerTypes.filter((handler) => handler !== undefined),
            (handler) => recoveryFailsWithDone(checker, handler),
          );
          const endsStreams = mapsToDone || recoveries.some(Boolean);
          if (!endsStreams) {
            return [];
          }
          const { line, column } = nodePosition(sourceFile, call);
          return [
            new ErrorMappedToDone({ location: `${displayName}:${line}:${column}`, operation }),
          ];
        }),
      { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
    );
    return violations.flat();
  });

export const findErrorMappingsToDone = <OpeningError, OpeningRequirement>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = path.dirname(yield* absolutePathOf(projectFile));
    const violations: ErrorMappedToDone[] = [];
    for (const { checker, sourceFiles } of yield* openedProjects) {
      for (const { sourceFile, displayName } of sourceFiles) {
        violations.push(
          ...(yield* fileViolations(checker, projectDirectory, sourceFile, displayName)),
        );
      }
    }
    if (violations.length > 0) {
      return yield* new ErrorMappingsRefused({ violations });
    }
  });
