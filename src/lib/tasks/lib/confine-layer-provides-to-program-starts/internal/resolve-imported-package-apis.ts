import { Array as Arrays, Effect } from "effect";
import type { Node, SourceFile } from "typescript/unstable/ast";
import {
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteralLikeNode,
} from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/async";
import type { Checker, Symbol as TypeScriptSymbol } from "typescript/unstable/async";

import {
  TASK_NAMESPACE_EXPORT,
  TASK_PACKAGE,
  TASK_MAKE_MEMBER,
} from "../../../../../shared/bans-each-permission-lifts.ts";
import {
  CONCURRENT_TYPESCRIPT_REQUESTS,
  followedImportAliases,
  packageFileOf,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";

const EFFECT_PACKAGE = "effect";
const PLATFORM_PACKAGES = "@effect/platform-";
const SCOPE_PREFIX = "@";
const SCOPED_NAME_SEGMENTS = 2;
const NAME_SEGMENTS = 1;
const NO_MEMBERS = [] as const;
const PACKAGE_ROOT = "";
export const EFFECT_MODULE = "Effect";
export const LAYER_MODULE = "Layer";
export const STREAM_MODULE = "Stream";
const MANAGED_RUNTIME = "ManagedRuntime";
const RUNTIME_MODULE = "Runtime";
const MAKE_RUN_MAIN = "makeRunMain";
const RUN_MAIN = "runMain";
const RUNNERS = [
  "runFork",
  "runCallback",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
] as const;
const RUNNERS_WITH_SERVICES = RUNNERS.map((runner) => `${runner}With`);
const DIRECT_CALLS: ReadonlySet<boolean> = new Set([false]);
const RETURNED_CALLS: ReadonlySet<boolean> = new Set([true]);
const EVERY_CALL: ReadonlySet<boolean> = new Set([false, true]);

const isEffectPackage = (packageName: string) => packageName === EFFECT_PACKAGE;

const isPlatformPackage = (packageName: string) => packageName.startsWith(PLATFORM_PACKAGES);

const isTaskPackage = (packageName: string) => packageName === TASK_PACKAGE;

const PROGRAM_STARTS = [
  {
    isPackage: isEffectPackage,
    module: EFFECT_MODULE,
    exports: RUNNERS,
    members: NO_MEMBERS,
    returnedBySignature: DIRECT_CALLS,
  },
  {
    isPackage: isEffectPackage,
    module: EFFECT_MODULE,
    exports: RUNNERS_WITH_SERVICES,
    members: NO_MEMBERS,
    returnedBySignature: RETURNED_CALLS,
  },
  {
    isPackage: isEffectPackage,
    module: MANAGED_RUNTIME,
    exports: [MANAGED_RUNTIME],
    members: RUNNERS,
    returnedBySignature: EVERY_CALL,
  },
  {
    isPackage: isEffectPackage,
    module: RUNTIME_MODULE,
    exports: [MAKE_RUN_MAIN],
    members: NO_MEMBERS,
    returnedBySignature: RETURNED_CALLS,
  },
  {
    isPackage: isPlatformPackage,
    module: undefined,
    exports: [RUN_MAIN],
    members: NO_MEMBERS,
    returnedBySignature: EVERY_CALL,
  },
  {
    isPackage: isTaskPackage,
    module: PACKAGE_ROOT,
    exports: [TASK_NAMESPACE_EXPORT],
    members: [TASK_MAKE_MEMBER],
    returnedBySignature: DIRECT_CALLS,
  },
] as const;

const packageModuleOf = (specifier: string) => {
  const segments = specifier.split("/");
  const nameLength = specifier.startsWith(SCOPE_PREFIX) ? SCOPED_NAME_SEGMENTS : NAME_SEGMENTS;
  return {
    packageName: segments.slice(0, nameLength).join("/"),
    module: segments.slice(nameLength).join("/"),
  };
};

const isWantedPackage = (packageName: string) =>
  isEffectPackage(packageName) || PROGRAM_STARTS.some(({ isPackage }) => isPackage(packageName));

const wantedModulesOf = (
  packageName: string,
  operations: readonly { readonly module: string }[],
) => {
  const starts = PROGRAM_STARTS.filter(({ isPackage }) => isPackage(packageName));
  const modules = [
    ...starts.map(({ module }) => module),
    ...(isEffectPackage(packageName) ? operations.map(({ module }) => module) : []),
  ];
  return modules.includes(undefined) ? undefined : new Set(modules);
};

const packageImportsIn = (sourceFiles: readonly { readonly sourceFile: SourceFile }[]) =>
  sourceFiles.flatMap(({ sourceFile }) =>
    sourceFile.statements.flatMap((statement) => {
      const isModuleRequest = isImportDeclaration(statement) || isExportDeclaration(statement);
      const specifier = isModuleRequest ? statement.moduleSpecifier : undefined;
      const isPackageRequest = specifier !== undefined && isStringLiteralLikeNode(specifier);
      return isPackageRequest ? [{ specifier, ...packageModuleOf(specifier.text) }] : [];
    }),
  );

const definedSymbols = (symbols: readonly (TypeScriptSymbol | undefined)[]) =>
  symbols.filter((symbol) => symbol !== undefined);

const publicModulesOf = (
  checker: Checker,
  imported: {
    readonly packageName: string;
    readonly module: string;
    readonly symbol: TypeScriptSymbol;
  },
  wanted: ReadonlySet<string | undefined> | undefined,
) =>
  Effect.gen(function* () {
    if (imported.module !== PACKAGE_ROOT) {
      return [imported];
    }
    const exported = yield* typeScriptRequest("list a package's exports", () =>
      checker.getExportsOfModule(imported.symbol),
    );
    const named = exported.filter(({ name }) => wanted === undefined || wanted.has(name));
    const targets = yield* followedImportAliases(checker, named);
    const namespaces = Arrays.zip(named, targets).flatMap(([alias, target]) => {
      const isNamespace = target !== undefined && (target.flags & SymbolFlags.ValueModule) !== 0;
      return isNamespace
        ? [{ packageName: imported.packageName, module: alias.name, symbol: target }]
        : [];
    });
    return [imported, ...namespaces];
  });

const exportsOf = (checker: Checker, module: TypeScriptSymbol, names: readonly string[]) =>
  Effect.gen(function* () {
    const exported = yield* typeScriptRequest("list a module's exports", () =>
      checker.getExportsOfModule(module),
    );
    return definedSymbols(
      yield* followedImportAliases(
        checker,
        exported.filter(({ name }) => names.includes(name)),
      ),
    );
  });

const membersOf = (checker: Checker, symbol: TypeScriptSymbol, names: readonly string[]) =>
  Effect.gen(function* () {
    const valueType = yield* typeScriptRequest("read an export's type", () =>
      checker.getTypeOfSymbol(symbol),
    );
    const declaredType = yield* typeScriptRequest("read an export's declared type", () =>
      checker.getDeclaredTypeOfSymbol(symbol),
    );
    const types = [valueType, declaredType].filter((type) => type !== undefined);
    const members = yield* Effect.forEach(types, (type) =>
      Effect.forEach(names, (name) =>
        typeScriptRequest("read an export's member", () => checker.getPropertyOfType(type, name)),
      ),
    );
    return definedSymbols(yield* followedImportAliases(checker, members.flat()));
  });

export const importedPackageApis = (
  checker: Checker,
  projectDirectory: string,
  sourceFiles: readonly { readonly sourceFile: SourceFile }[],
  operations: readonly { readonly module: string; readonly names: ReadonlySet<string> }[],
) =>
  Effect.gen(function* () {
    const imports = packageImportsIn(sourceFiles).filter(({ packageName }) =>
      isWantedPackage(packageName),
    );
    const symbols = yield* typeScriptRequest("resolve imported packages", () =>
      checker.getSymbolAtLocation(imports.map(({ specifier }) => specifier)),
    );
    const resolved = new Map(
      imports.flatMap(({ packageName, module }, index) => {
        const symbol = symbols[index];
        return symbol === undefined
          ? []
          : [[`${packageName}\0${module}\0${symbol.id}`, { packageName, module, symbol }] as const];
      }),
    );
    const modules = (yield* Effect.forEach(
      resolved.values(),
      (imported) =>
        publicModulesOf(checker, imported, wantedModulesOf(imported.packageName, operations)),
      { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
    )).flat();
    const effectExports = new Map<number, string>();
    for (const { module, names } of operations) {
      const effectModules = modules.filter(
        (candidate) => isEffectPackage(candidate.packageName) && candidate.module === module,
      );
      for (const { symbol } of effectModules) {
        for (const exported of yield* exportsOf(checker, symbol, [...names])) {
          effectExports.set(exported.id, module);
        }
      }
    }
    const programStarts = new Map<Node, ReadonlySet<boolean>>();
    const programStartFiles = new Set<string>();
    for (const start of PROGRAM_STARTS) {
      const startModules = modules.filter(
        ({ packageName, module }) =>
          start.isPackage(packageName) && (start.module === undefined || start.module === module),
      );
      for (const { symbol } of startModules) {
        const exported = yield* exportsOf(checker, symbol, start.exports);
        const { members } = start;
        const callees =
          members.length === 0
            ? exported
            : (yield* Effect.forEach(exported, (owner) =>
                membersOf(checker, owner, members),
              )).flat();
        for (const declaration of callees.flatMap(({ declarations }) => declarations)) {
          const file = packageFileOf(projectDirectory, declaration.path);
          const node = yield* typeScriptRequest("read a program start's declaration", () =>
            declaration.resolve(),
          );
          const isDeclaredInAPackage = file !== undefined && node !== undefined;
          if (isDeclaredInAPackage) {
            programStartFiles.add(file);
            programStarts.set(node, start.returnedBySignature);
          }
        }
      }
    }
    return { projectDirectory, effectExports, programStarts, programStartFiles };
  });
