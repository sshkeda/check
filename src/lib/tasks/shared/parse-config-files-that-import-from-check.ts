import { Effect, FileSystem, Option, Path, Result } from "effect";
import { parseSync } from "oxc-parser";
import type { ExportDefaultDeclaration, ImportDeclaration, Program } from "oxc-parser";

import {
  FORMAT_CONFIG_BINDING,
  FORMAT_CONFIG_FILE,
  LINT_CONFIG_FILE,
} from "../../../shared/config-file-names.ts";
import { lineNumbersIn } from "./count-the-line-of-an-offset.ts";
import { runtimeModuleResolver } from "./create-the-module-resolver.ts";
import type { CONFIG_FILE_VIOLATION } from "./project-config-and-tool-errors.ts";
import {
  CHECK_PACKAGE,
  ConfigFileExportsSomethingElse,
  ConfigFileHoldsOtherStatement,
  ConfigFileHoldsSomethingElse,
  ConfigFileImportsFromOutsideCheck,
  ConfigFileMissing,
  ConfigFileMissingDefaultExport,
  ConfigFileMissingImport,
  ConfigFileUnparsable,
  ModuleRequestUnresolvable,
} from "./project-config-and-tool-errors.ts";
import { namedPackageManifestAt } from "./read-named-package-manifests.ts";
import { realPathOf } from "./resolve-absolute-paths.ts";

export const LINT_CONFIG = {
  file: LINT_CONFIG_FILE,
  binding: "lintConfig",
  argumentShapes: ["{ ... }"],
} as const;

export const FORMAT_CONFIG = {
  file: FORMAT_CONFIG_FILE,
  binding: FORMAT_CONFIG_BINDING,
  argumentShapes: undefined,
} as const;

const INSTALLED_PACKAGES_DIRECTORY = "node_modules";

const defaultExportOf = (config: typeof FORMAT_CONFIG | typeof LINT_CONFIG) =>
  config.argumentShapes === undefined
    ? config.binding
    : `${config.binding}(${config.argumentShapes.join(", ")})`;

const importOf = (config: Parameters<typeof defaultExportOf>[0]) =>
  `import { ${config.binding} } from "${CHECK_PACKAGE}"`;

const configCallOf = (
  config: Parameters<typeof defaultExportOf>[0],
  exported: ExportDefaultDeclaration,
) => {
  const call = exported.declaration;
  const isCallOfTheBinding =
    config.argumentShapes !== undefined &&
    call.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    call.callee.name === config.binding &&
    call.arguments.length === config.argumentShapes.length;
  return isCallOfTheBinding ? call : undefined;
};

const exportsTheConfig = (
  config: Parameters<typeof defaultExportOf>[0],
  exported: ExportDefaultDeclaration,
  call: ReturnType<typeof configCallOf>,
) =>
  config.argumentShapes === undefined
    ? exported.declaration.type === "Identifier" && exported.declaration.name === config.binding
    : call !== undefined;

const exportViolationsOf = (
  config: Parameters<typeof defaultExportOf>[0],
  file: string,
  exported: ExportDefaultDeclaration | undefined,
  call: ReturnType<typeof configCallOf>,
  lineOf: (offset: number) => string,
) => {
  if (exported === undefined) {
    return [
      new ConfigFileMissingDefaultExport({
        file,
        defaultExport: defaultExportOf(config),
      }),
    ];
  }
  if (!exportsTheConfig(config, exported, call)) {
    return [
      new ConfigFileExportsSomethingElse({
        location: lineOf(exported.declaration.start),
        defaultExport: defaultExportOf(config),
      }),
    ];
  }
  return [];
};

const importsOnlyTheBinding = (
  config: Parameters<typeof defaultExportOf>[0],
  statement: ImportDeclaration,
) => {
  const [specifier, ...otherSpecifiers] = statement.specifiers;
  const importsOneValue =
    statement.importKind !== "type" &&
    otherSpecifiers.length === 0 &&
    specifier?.type === "ImportSpecifier" &&
    specifier.importKind !== "type";
  return (
    importsOneValue &&
    specifier.imported.type === "Identifier" &&
    specifier.imported.name === config.binding &&
    specifier.local.name === config.binding
  );
};

const statementViolationsOf = (
  config: Parameters<typeof defaultExportOf>[0],
  file: string,
  body: Program["body"],
  exported: ExportDefaultDeclaration | undefined,
  bindingImport: ImportDeclaration | undefined,
  lineOf: (offset: number) => string,
) => {
  const otherStatements = body.filter(
    (statement) => statement !== exported && statement !== bindingImport,
  );
  const lacksOnlyTheImport = bindingImport === undefined && otherStatements.length === 0;
  return lacksOnlyTheImport
    ? [new ConfigFileMissingImport({ file, configImport: importOf(config) })]
    : otherStatements.map(
        (statement) =>
          new ConfigFileHoldsOtherStatement({
            location: lineOf(statement.start),
            configImport: importOf(config),
            defaultExport: defaultExportOf(config),
          }),
      );
};

const STATEMENTS_OF_A_CONFIG_WITHOUT_ARGUMENTS = 2;

const shapeViolationsOf = (
  config: Parameters<typeof defaultExportOf>[0],
  file: string,
  body: Program["body"],
  exported: ExportDefaultDeclaration | undefined,
  call: ReturnType<typeof configCallOf>,
  bindingImport: ImportDeclaration | undefined,
  lineOf: (offset: number) => string,
) => {
  if (config.argumentShapes !== undefined) {
    return [
      ...exportViolationsOf(config, file, exported, call, lineOf),
      ...statementViolationsOf(config, file, body, exported, bindingImport, lineOf),
    ];
  }
  const holdsOnlyTheImportAndTheExport =
    body.length === STATEMENTS_OF_A_CONFIG_WITHOUT_ARGUMENTS &&
    bindingImport !== undefined &&
    exported !== undefined &&
    exportsTheConfig(config, exported, call);
  return holdsOnlyTheImportAndTheExport
    ? []
    : [
        new ConfigFileHoldsSomethingElse({
          file,
          configImport: importOf(config),
          defaultExport: defaultExportOf(config),
        }),
      ];
};

export const parsedConfigFile = (
  config: Parameters<typeof defaultExportOf>[0],
  file: string,
  text: string,
) => {
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) {
    return Result.fail<readonly (typeof CONFIG_FILE_VIOLATION.Type)[]>(
      parsed.errors.map((error) => new ConfigFileUnparsable({ file, reason: error.message })),
    );
  }
  const lineAt = lineNumbersIn(text);
  const lineOf = (offset: number) => `${file}:${lineAt(offset)}`;
  const { body } = parsed.program;
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const bindingImport = body
    .filter((statement) => statement.type === "ImportDeclaration")
    .find((statement) => importsOnlyTheBinding(config, statement));
  const call = exported === undefined ? undefined : configCallOf(config, exported);
  return Result.succeed({
    call,
    bindingImport,
    violations: shapeViolationsOf(config, file, body, exported, call, bindingImport, lineOf),
    lineOf,
  });
};

export const isFormatConfigTextRefusedIn = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configFile = path.join(directory, FORMAT_CONFIG.file);
    if (!(yield* fileSystem.exists(configFile))) {
      return false;
    }
    const parsed = parsedConfigFile(
      FORMAT_CONFIG,
      FORMAT_CONFIG.file,
      yield* fileSystem.readFileString(configFile),
    );
    return Result.isFailure(parsed) || parsed.success.violations.length > 0;
  });

const isCheckPackage = (packageManifest: string | undefined, projectDirectory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (packageManifest === undefined) {
      return false;
    }
    const packageRoot = path.dirname(packageManifest);
    const isInstalledOrTheProject =
      packageRoot === projectDirectory ||
      packageRoot.split(path.sep).includes(INSTALLED_PACKAGES_DIRECTORY);
    if (!isInstalledOrTheProject) {
      return false;
    }
    return Option.exists(
      yield* namedPackageManifestAt(packageManifest),
      ({ name }) => name === CHECK_PACKAGE,
    );
  });

const importViolationsOf = (
  config: Parameters<typeof defaultExportOf>[0],
  directory: string,
  bindingImport: ImportDeclaration,
  lineOf: (offset: number) => string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = yield* realPathOf(directory);
    const request = bindingImport.source.value;
    const location = lineOf(bindingImport.start);
    const resolver = yield* runtimeModuleResolver;
    const resolved = yield* Effect.tryPromise({
      try: () => resolver.resolveFileAsync(path.join(projectDirectory, config.file), request),
      catch: (cause) =>
        new ModuleRequestUnresolvable({ request, importingFile: location, reason: String(cause) }),
    });
    if (resolved.path === undefined) {
      return [
        new ModuleRequestUnresolvable({
          request,
          importingFile: location,
          reason: resolved.error ?? "the resolver returned no file and no error",
        }),
      ];
    }
    if (yield* isCheckPackage(resolved.packageJsonPath, projectDirectory)) {
      return [];
    }
    return [
      new ConfigFileImportsFromOutsideCheck({
        location,
        binding: config.binding,
        request,
        resolvedFile: path.relative(projectDirectory, resolved.path),
      }),
    ];
  });

export const parsedConfigFileIn = (
  directory: string,
  config: Parameters<typeof defaultExportOf>[0],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configFile = path.join(directory, config.file);
    if (!(yield* fileSystem.exists(configFile))) {
      return Result.fail<readonly (typeof CONFIG_FILE_VIOLATION.Type)[]>([
        new ConfigFileMissing({ file: config.file }),
      ]);
    }
    const parsed = parsedConfigFile(
      config,
      config.file,
      yield* fileSystem.readFileString(configFile),
    );
    if (Result.isFailure(parsed)) {
      return parsed;
    }
    const { bindingImport, violations, lineOf } = parsed.success;
    const namesTheImportToWrite = config.argumentShapes === undefined && violations.length > 0;
    const hasNoImportToResolve = bindingImport === undefined || namesTheImportToWrite;
    if (hasNoImportToResolve) {
      return parsed;
    }
    return Result.succeed({
      ...parsed.success,
      violations: [
        ...violations,
        ...(yield* importViolationsOf(config, directory, bindingImport, lineOf)),
      ],
    });
  });
