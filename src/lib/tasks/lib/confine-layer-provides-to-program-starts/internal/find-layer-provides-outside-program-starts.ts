import { Array as Arrays, Effect, Option, Path } from "effect";
import type { Layer } from "effect";
import { NodeFlags } from "typescript/unstable/ast";
import type { CallExpression, Node, SourceFile } from "typescript/unstable/ast";
import {
  isArrowFunction,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isExportKeyword,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isReturnStatement,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  isYieldExpression,
} from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/async";
import type { Checker, Symbol as TypeScriptSymbol, Type } from "typescript/unstable/async";

import { isUnderTestDirectory } from "../../../shared/classify-files-by-role.ts";
import {
  callsIn,
  CONCURRENT_TYPESCRIPT_REQUESTS,
  nodePosition,
  packageCalleeOf,
  parentOf,
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
import {
  LayerProvidedOutsideProgramStart,
  LayerProvidesOutsideProgramStarts,
  PROVIDED_VALUES,
} from "./layer-provide-errors.ts";
import {
  EFFECT_MODULE,
  importedPackageApis,
  LAYER_MODULE,
  STREAM_MODULE,
} from "./resolve-imported-package-apis.ts";

const LAYER_TYPE_ID = "~effect/Layer" satisfies keyof Layer.Any;
const PROVIDE = "provide";
const PROVIDE_OPERATIONS: ReadonlySet<string> = new Set([PROVIDE, "provideContext"]);
const LAYER_BUILDERS: ReadonlySet<string> = new Set([
  "build",
  "buildWithScope",
  "buildWithMemoMap",
]);
const CONTEXT_KEEPING_OPERATIONS: ReadonlySet<string> = new Set([
  "scoped",
  "orDie",
  "mapError",
  "withSpan",
]);
const SUCCESS_CONTINUATIONS: ReadonlySet<string> = new Set(["flatMap", "andThen", "tap", "map"]);
const EFFECT_OPERATIONS = [
  {
    module: EFFECT_MODULE,
    names: new Set([
      ...PROVIDE_OPERATIONS,
      ...CONTEXT_KEEPING_OPERATIONS,
      ...SUCCESS_CONTINUATIONS,
    ]),
  },
  { module: LAYER_MODULE, names: LAYER_BUILDERS },
  { module: STREAM_MODULE, names: PROVIDE_OPERATIONS },
];
const PROVIDING_MODULES = [EFFECT_MODULE, STREAM_MODULE];
const PROVIDED_ARGUMENTS = 2;

const anyOf = <Item, Failure>(
  items: Iterable<Item>,
  predicate: (item: Item) => Effect.Effect<boolean, Failure>,
) => Effect.findFirst(items, predicate).pipe(Effect.map(Option.isSome));

const isFunctionLike = (node: Node) =>
  isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node);

const returnedBy = (callable: Node) => {
  const body = isFunctionLike(callable) ? callable.body : undefined;
  if (body === undefined) {
    return [];
  }
  if (!isBlock(body)) {
    return [body];
  }
  const returned: Node[] = [];
  const visit = (node: Node) => {
    if (isReturnStatement(node)) {
      returned.push(...(node.expression === undefined ? [] : [node.expression]));
    }
    if (!isFunctionLike(node)) {
      node.forEachChild(visit);
    }
  };
  body.forEachChild(visit);
  return returned;
};

const isExportOf = (
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  symbol: TypeScriptSymbol | undefined,
  module: string,
  names: ReadonlySet<string>,
) => symbol !== undefined && names.has(symbol.name) && apis.effectExports.get(symbol.id) === module;

const stepsBefore = (step: Node) => {
  const { parent } = step;
  if (!isCallExpression(parent)) {
    return [];
  }
  return Arrays.takeWhile(pipedStepsOf(parent) ?? [], (piped) => piped !== step);
};

const effectsContinuedBy = (callback: Node) => {
  const { parent: step } = callback;
  if (!isCallExpression(step)) {
    return [];
  }
  const [first] = step.arguments;
  const isDataFirst = step.arguments.length > 1 && first !== undefined && first !== callback;
  return isDataFirst ? [first] : stepsBefore(step);
};

const isLayerType = (checker: Checker, type: Type | undefined) =>
  Effect.gen(function* () {
    if (type === undefined) {
      return false;
    }
    const typeId = yield* typeScriptRequest("read the layer type id", () =>
      checker.getPropertyOfType(type, LAYER_TYPE_ID),
    );
    if (typeId !== undefined) {
      return true;
    }
    const isArray = yield* typeScriptRequest("check for an array of layers", () =>
      checker.isArrayLikeType(type),
    );
    if (!isArray) {
      return false;
    }
    const indexes = yield* typeScriptRequest("read the array element type", () =>
      checker.getIndexInfosOfType(type),
    );
    return yield* anyOf(indexes, ({ valueType }) =>
      typeScriptRequest("read the layer type id", () =>
        checker.getPropertyOfType(valueType, LAYER_TYPE_ID),
      ).pipe(Effect.map((elementTypeId) => elementTypeId !== undefined)),
    );
  });

const tracedValues = (
  checker: Checker,
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
) => {
  const cycleCuts: Node[] = [];
  const isAlreadyFollowed = (declaration: Node, seen: ReadonlySet<Node>) => {
    const isFollowed = seen.has(declaration);
    if (isFollowed) {
      cycleCuts.push(declaration);
    }
    return isFollowed;
  };

  const symbolOf = (name: Node) =>
    Effect.gen(function* () {
      const symbol = yield* typeScriptRequest("resolve a referenced value", () =>
        checker.getSymbolAtLocation(name),
      );
      const isImportAlias = symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0;
      return isImportAlias
        ? yield* typeScriptRequest("follow an import alias", () => checker.getAliasedSymbol(symbol))
        : symbol;
    });

  const declarationOf = (name: Node) =>
    Effect.gen(function* () {
      const symbol = yield* symbolOf(name);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations.at(0);
      return declaration === undefined
        ? undefined
        : yield* typeScriptRequest("read a value's declaration", () => declaration.resolve());
    });

  const isLayerBuilder = (node: Node) =>
    Effect.gen(function* () {
      const name = referencedNameOf(node);
      return (
        name !== undefined && isExportOf(apis, yield* symbolOf(name), LAYER_MODULE, LAYER_BUILDERS)
      );
    });

  const functionReturnsOf = (callee: Node, seen: ReadonlySet<Node>) =>
    Effect.gen(function* () {
      const name = referencedNameOf(callee);
      const declaration = name === undefined ? undefined : yield* declarationOf(name);
      const isUnfollowed = declaration !== undefined && !isAlreadyFollowed(declaration, seen);
      if (!isUnfollowed) {
        return;
      }
      const isInitializedVariable =
        isVariableDeclaration(declaration) && declaration.initializer !== undefined;
      const initializer = isInitializedVariable
        ? withoutWrappers(declaration.initializer)
        : declaration;
      return { returned: returnedBy(initializer), seen: new Set([...seen, declaration]) };
    });

  const isEffectOperation = (callee: Node, operations: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const name = referencedNameOf(callee);
      return (
        name !== undefined && isExportOf(apis, yield* symbolOf(name), EFFECT_MODULE, operations)
      );
    });

  const remembered = (
    known: Map<Node, boolean>,
    node: Node,
    trace: Effect.Effect<boolean, Effect.Error<ReturnType<typeof symbolOf>>>,
  ) =>
    Effect.suspend(() => {
      const result = known.get(node);
      if (result !== undefined) {
        return Effect.succeed(result);
      }
      const cutsBefore = cycleCuts.length;
      return trace.pipe(
        Effect.tap((traced) =>
          Effect.sync(() => {
            const isDefinitive = traced || cycleCuts.length === cutsBefore;
            if (isDefinitive) {
              known.set(node, traced);
            }
          }),
        ),
      );
    });

  const effectsBuildingContexts = new Map<Node, boolean>();
  const builtContexts = new Map<Node, boolean>();

  const tracers = {
    buildsContext: (
      node: Node,
      seen: ReadonlySet<Node>,
    ): Effect.Effect<boolean, Effect.Error<ReturnType<typeof symbolOf>>> =>
      remembered(
        effectsBuildingContexts,
        node,
        Effect.gen(function* () {
          const effect = withoutWrappers(node);
          if (isConditionalExpression(effect)) {
            return yield* anyOf([effect.whenTrue, effect.whenFalse], (branch) =>
              tracers.buildsContext(branch, seen),
            );
          }
          if (yield* isLayerBuilder(effect)) {
            return true;
          }
          const reference = referencedNameOf(effect);
          if (reference !== undefined) {
            const declaration = yield* declarationOf(reference);
            const isUnseenConst =
              declaration !== undefined &&
              !isAlreadyFollowed(declaration, seen) &&
              isVariableDeclaration(declaration) &&
              declaration.initializer !== undefined;
            return (
              isUnseenConst &&
              (yield* tracers.buildsContext(
                declaration.initializer,
                new Set([...seen, declaration]),
              ))
            );
          }
          if (!isCallExpression(effect)) {
            return false;
          }
          const steps = pipedStepsOf(effect);
          if (steps !== undefined) {
            return yield* anyOf(steps, (step) => tracers.buildsContext(step, seen));
          }
          const callee = withoutWrappers(effect.expression);
          const isCurriedOrBuilder = isCallExpression(callee) || (yield* isLayerBuilder(callee));
          if (isCurriedOrBuilder) {
            return yield* tracers.buildsContext(callee, seen);
          }
          const [input] = effect.arguments;
          const keepsTheInputContext =
            input !== undefined && (yield* isEffectOperation(callee, CONTEXT_KEEPING_OPERATIONS));
          if (keepsTheInputContext) {
            return yield* tracers.buildsContext(input, seen);
          }
          const generated = effect.arguments
            .filter(
              (argument) => isFunctionExpression(argument) && argument.asteriskToken !== undefined,
            )
            .flatMap((generator) => returnedBy(generator));
          if (yield* anyOf(generated, (returned) => tracers.isBuiltContext(returned, seen))) {
            return true;
          }
          const made = yield* functionReturnsOf(callee, seen);
          return (
            made !== undefined &&
            (yield* anyOf(made.returned, (returned) => tracers.buildsContext(returned, made.seen)))
          );
        }),
      ),
    isBuiltContext: (
      node: Node,
      seen: ReadonlySet<Node>,
    ): Effect.Effect<boolean, Effect.Error<ReturnType<typeof symbolOf>>> =>
      remembered(
        builtContexts,
        node,
        Effect.gen(function* () {
          const value = withoutWrappers(node);
          if (isYieldExpression(value)) {
            const isDelegated = value.asteriskToken !== undefined && value.expression !== undefined;
            return isDelegated && (yield* tracers.buildsContext(value.expression, seen));
          }
          const reference = referencedNameOf(value);
          if (reference === undefined) {
            return false;
          }
          const declaration = yield* declarationOf(reference);
          const isUnfollowed = declaration !== undefined && !isAlreadyFollowed(declaration, seen);
          if (!isUnfollowed) {
            return false;
          }
          const followed = new Set([...seen, declaration]);
          if (isVariableDeclaration(declaration)) {
            return (
              declaration.initializer !== undefined &&
              (yield* tracers.isBuiltContext(declaration.initializer, followed))
            );
          }
          if (!isParameterDeclaration(declaration)) {
            return false;
          }
          const { parent: step } = declaration.parent;
          const continuesTheSuccess =
            isCallExpression(step) &&
            (yield* isEffectOperation(step.expression, SUCCESS_CONTINUATIONS));
          if (!continuesTheSuccess) {
            return false;
          }
          return yield* anyOf(effectsContinuedBy(declaration.parent), (continued) =>
            tracers.buildsContext(continued, followed),
          );
        }),
      ),
  };

  return tracers;
};

const RUNNER_CALLS = new WeakMap<CallExpression, boolean>();

const isRunnerCallee = (
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  callee: Effect.Success<ReturnType<typeof packageCalleeOf>>,
) =>
  callee !== undefined &&
  (apis.programStarts.get(callee.declaration)?.has(callee.returnedBySignature) ?? false);

const startsTheProgram = (
  checker: Checker,
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  call: CallExpression,
) =>
  Effect.gen(function* () {
    const known = RUNNER_CALLS.get(call);
    if (known !== undefined) {
      return known;
    }
    const isRunner = isRunnerCallee(
      apis,
      yield* packageCalleeOf(checker, apis.projectDirectory, call, (file) =>
        apis.programStartFiles.has(file),
      ),
    );
    RUNNER_CALLS.set(call, isRunner);
    return isRunner;
  });

const isRunnerArgument = (
  checker: Checker,
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  node: Node,
) => {
  const { parent } = node;
  const isArgument =
    isCallExpression(parent) && parent.arguments.some((argument) => argument === node);
  return isArgument ? startsTheProgram(checker, apis, parent) : Effect.succeed(false);
};

const isExported = (declaration: Node) => {
  const statement = declaration.parent.parent;
  return (
    isVariableStatement(statement) &&
    (statement.modifiers?.some((modifier) => isExportKeyword(modifier)) ?? false)
  );
};

const isConstOnlyRunByARunner = (
  checker: Checker,
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  sourceFile: SourceFile,
  declaration: Node,
) =>
  Effect.gen(function* () {
    const isLocalConst =
      isVariableDeclaration(declaration) &&
      isIdentifier(declaration.name) &&
      (declaration.parent.flags & NodeFlags.BlockScoped) === NodeFlags.Const &&
      !isExported(declaration);
    if (!isLocalConst) {
      return false;
    }
    const symbol = yield* typeScriptRequest("resolve a const", () =>
      checker.getSymbolAtLocation(declaration.name),
    );
    if (symbol === undefined) {
      return false;
    }
    const references = yield* typeScriptRequest("find a const's references", () =>
      checker.getReferencesToSymbolInFile(sourceFile.fileName, symbol),
    );
    const reads = yield* Effect.forEach(references, (reference) =>
      typeScriptRequest("read a const's reference", () => reference.resolve()),
    );
    const [onlyRead, ...otherReads] = reads.filter(
      (read) => read !== undefined && read.pos !== declaration.name.pos,
    );
    const isReadOnce = onlyRead !== undefined && otherReads.length === 0;
    return isReadOnce && (yield* isRunnerArgument(checker, apis, outermostWrapperOf(onlyRead)));
  });

const isWhereTheProgramStarts = (
  checker: Checker,
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  sourceFile: SourceFile,
  node: Node,
): Effect.Effect<boolean, Effect.Error<ReturnType<typeof startsTheProgram>>> =>
  Effect.gen(function* () {
    const parent = parentOf(node);
    if (parent === undefined) {
      return false;
    }
    if (yield* isRunnerArgument(checker, apis, node)) {
      return true;
    }
    const isInitializer = isVariableDeclaration(parent) && parent.initializer === node;
    const isConstRunByARunner =
      isInitializer && (yield* isConstOnlyRunByARunner(checker, apis, sourceFile, parent));
    if (isConstRunByARunner) {
      return true;
    }
    return yield* isWhereTheProgramStarts(checker, apis, sourceFile, parent);
  });

const providedArgumentsOf = (call: CallExpression) =>
  call.arguments
    .slice(0, PROVIDED_ARGUMENTS)
    .filter((argument) => !isObjectLiteralExpression(argument) && !isSpreadElement(argument));

const provideOperationsIn = (
  checker: Checker,
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  calls: readonly CallExpression[],
) =>
  Effect.gen(function* () {
    const named = calls.flatMap((call) => {
      const name = referencedNameOf(call.expression);
      return name === undefined ? [] : [{ call, name }];
    });
    const symbols = yield* typeScriptRequest("resolve called values", () =>
      checker.getSymbolAtLocation(named.map(({ name }) => name)),
    );
    const aliases = new Map(
      symbols.flatMap((symbol) => {
        const isAlias = symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0;
        return isAlias ? [[symbol.id, symbol] as const] : [];
      }),
    );
    const aliased = new Map(
      yield* Effect.forEach(
        aliases.values(),
        (alias) =>
          typeScriptRequest("follow an import alias", () => checker.getAliasedSymbol(alias)).pipe(
            Effect.map((target) => [alias.id, target] as const),
          ),
        { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
      ),
    );
    return named.flatMap(({ call }, index) => {
      const symbol = symbols[index];
      const target = symbol === undefined ? undefined : (aliased.get(symbol.id) ?? symbol);
      if (target === undefined) {
        return [];
      }
      const module = PROVIDING_MODULES.find((candidate) =>
        isExportOf(apis, target, candidate, PROVIDE_OPERATIONS),
      );
      return module === undefined ? [] : [{ call, module, operation: target.name }];
    });
  });

const providedValueOf = (
  checker: Checker,
  isBuiltContext: ReturnType<typeof tracedValues>["isBuiltContext"],
  call: CallExpression,
  operation: string,
) =>
  Effect.gen(function* () {
    const provided = providedArgumentsOf(call);
    if (operation === PROVIDE) {
      const types = yield* typeScriptRequest("read the provided types", () =>
        checker.getTypeAtLocation(provided),
      );
      if (yield* anyOf(types, (type) => isLayerType(checker, type))) {
        return PROVIDED_VALUES[0];
      }
    }
    const isBuilt = yield* anyOf(provided, (argument) => isBuiltContext(argument, new Set()));
    return isBuilt ? PROVIDED_VALUES[1] : undefined;
  });

const fileViolations = (
  checker: Checker,
  apis: Effect.Success<ReturnType<typeof importedPackageApis>>,
  isBuiltContext: ReturnType<typeof tracedValues>["isBuiltContext"],
  sourceFile: SourceFile,
  displayName: string,
) =>
  Effect.gen(function* () {
    const provides = yield* provideOperationsIn(checker, apis, callsIn(sourceFile));
    const violations = yield* Effect.forEach(provides, ({ call, module, operation }) =>
      Effect.gen(function* () {
        const provided = yield* providedValueOf(checker, isBuiltContext, call, operation);
        if (provided === undefined) {
          return [];
        }
        if (yield* isWhereTheProgramStarts(checker, apis, sourceFile, call)) {
          return [];
        }
        const { line, column } = nodePosition(sourceFile, call);
        return [
          new LayerProvidedOutsideProgramStart({
            location: `${displayName}:${line}:${column}`,
            module,
            operation,
            provided,
          }),
        ];
      }),
    );
    return violations.flat();
  });

export const findLayerProvidesOutsideProgramStarts = <OpeningError, OpeningRequirement>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const projectDirectory = (yield* Path.Path).dirname(yield* absolutePathOf(projectFile));
    const projects = yield* Effect.forEach(yield* openedProjects, (project) =>
      importedPackageApis(
        project.checker,
        projectDirectory,
        project.allSourceFiles,
        EFFECT_OPERATIONS,
      ).pipe(Effect.map((apis) => ({ ...project, apis }))),
    );
    const violationsOfEachFile = yield* Effect.forEach(
      projects.flatMap(({ checker, apis, sourceFiles }) => {
        const { isBuiltContext } = tracedValues(checker, apis);
        return sourceFiles
          .filter(({ displayName }) => !isUnderTestDirectory(displayName))
          .map(({ sourceFile, displayName }) => ({
            checker,
            apis,
            isBuiltContext,
            sourceFile,
            displayName,
          }));
      }),
      ({ checker, apis, isBuiltContext, sourceFile, displayName }) =>
        fileViolations(checker, apis, isBuiltContext, sourceFile, displayName),
      { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
    );
    const violations = violationsOfEachFile.flat();
    if (violations.length > 0) {
      return yield* new LayerProvidesOutsideProgramStarts({ violations });
    }
  });
