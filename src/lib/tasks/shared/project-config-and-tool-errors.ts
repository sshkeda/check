import { Record, Schema } from "effect";

import { FORMAT_CONFIG_FILE } from "../../../shared/config-file-names.ts";
import { listedViolations } from "../../../shared/format-reported-failures.ts";
import { MalformedGrant } from "../../../shared/permission-grant-errors.ts";

export class TypeScriptApiFailed extends Schema.TaggedError<TypeScriptApiFailed>()(
  "TypeScriptApiFailed",
  { operation: Schema.String, reason: Schema.String },
) {
  public override get message() {
    return `the TypeScript API failed to ${this.operation}: ${this.reason}`;
  }
}

export class TypeScriptApiProcessStopped extends Schema.TaggedError<TypeScriptApiProcessStopped>()(
  "TypeScriptApiProcessStopped",
  { reason: Schema.String },
) {
  public override get message() {
    return this.reason;
  }
}

export class TypeScriptReturnedNothing extends Schema.TaggedError<TypeScriptReturnedNothing>()(
  "TypeScriptReturnedNothing",
  { operation: Schema.String },
) {
  public override get message() {
    return `the TypeScript API returned nothing when asked to ${this.operation}`;
  }
}

export class CheckCrashed extends Schema.TaggedError<CheckCrashed>()("CheckCrashed", {
  check: Schema.String,
  reason: Schema.String,
}) {
  public override get message() {
    return `${this.check} crashed: ${this.reason}`;
  }
}

export class ModuleRequestUnresolvable extends Schema.TaggedError<ModuleRequestUnresolvable>()(
  "ModuleRequestUnresolvable",
  { request: Schema.String, importingFile: Schema.String, reason: Schema.String },
) {
  public get location() {
    return this.importingFile;
  }
  public override get message() {
    return `could not resolve ${this.request}: ${this.reason}`;
  }
}

export class ProgramFilesOutsideProject extends Schema.TaggedError<ProgramFilesOutsideProject>()(
  "ProgramFilesOutsideProject",
  { projectFile: Schema.String, listedFile: Schema.String },
) {
  public get location() {
    return this.projectFile;
  }
  public override get message() {
    return `compiles no file inside its directory, only files such as ${this.listedFile}`;
  }
}

export class ConfigFileMissing extends Schema.TaggedError<ConfigFileMissing>()(
  "ConfigFileMissing",
  { file: Schema.String },
) {
  public get location() {
    return this.file;
  }
  public override get message() {
    return `does not exist`;
  }
}

export class ConfigFileUnparsable extends Schema.TaggedError<ConfigFileUnparsable>()(
  "ConfigFileUnparsable",
  { file: Schema.String, reason: Schema.String },
) {
  public get location() {
    return this.file;
  }
  public override get message() {
    return `does not parse: ${this.reason}`;
  }
}

export class ConfigFileMissingDefaultExport extends Schema.TaggedError<ConfigFileMissingDefaultExport>()(
  "ConfigFileMissingDefaultExport",
  { file: Schema.String, defaultExport: Schema.String },
) {
  public get location() {
    return this.file;
  }
  public override get message() {
    return `has no export default ${this.defaultExport}`;
  }
}

export class ConfigFileExportsSomethingElse extends Schema.TaggedError<ConfigFileExportsSomethingElse>()(
  "ConfigFileExportsSomethingElse",
  { location: Schema.String, defaultExport: Schema.String },
) {
  public override get message() {
    return `exports something other than ${this.defaultExport}`;
  }
}

export const CHECK_PACKAGE = "@sshkeda/check";

export class ConfigFileHoldsOtherStatement extends Schema.TaggedError<ConfigFileHoldsOtherStatement>()(
  "ConfigFileHoldsOtherStatement",
  { location: Schema.String, configImport: Schema.String, defaultExport: Schema.String },
) {
  public override get message() {
    return `holds a statement other than ${this.configImport} and export default ${this.defaultExport}`;
  }
}

export class ConfigFileHoldsSomethingElse extends Schema.TaggedError<ConfigFileHoldsSomethingElse>()(
  "ConfigFileHoldsSomethingElse",
  { file: Schema.String, configImport: Schema.String, defaultExport: Schema.String },
) {
  public get location() {
    return this.file;
  }
  public override get message() {
    return `holds something other than check's config`;
  }
}

export class ConfigFileMissingImport extends Schema.TaggedError<ConfigFileMissingImport>()(
  "ConfigFileMissingImport",
  { file: Schema.String, configImport: Schema.String },
) {
  public get location() {
    return this.file;
  }
  public override get message() {
    return `has no ${this.configImport}`;
  }
}

export class ConfigFileImportsFromOutsideCheck extends Schema.TaggedError<ConfigFileImportsFromOutsideCheck>()(
  "ConfigFileImportsFromOutsideCheck",
  {
    location: Schema.String,
    binding: Schema.String,
    request: Schema.String,
    resolvedFile: Schema.String,
  },
) {
  public override get message() {
    return `imports ${this.binding} from ${this.request}, which resolves to ${this.resolvedFile} instead of a file of ${CHECK_PACKAGE}`;
  }
}

export class LintConfigArgumentNotLiteral extends Schema.TaggedError<LintConfigArgumentNotLiteral>()(
  "LintConfigArgumentNotLiteral",
  { location: Schema.String },
) {
  public override get message() {
    return `passes lintConfig() something other than literals`;
  }
}

export class LintConfigKeyRepeated extends Schema.TaggedError<LintConfigKeyRepeated>()(
  "LintConfigKeyRepeated",
  { location: Schema.String, key: Schema.String },
) {
  public override get message() {
    return `names ${this.key} more than once in one object passed to lintConfig()`;
  }
}

const CONFIG_FILE_VIOLATIONS = [
  ConfigFileMissing,
  ConfigFileUnparsable,
  ConfigFileMissingDefaultExport,
  ConfigFileExportsSomethingElse,
  ConfigFileHoldsOtherStatement,
  ConfigFileHoldsSomethingElse,
  ConfigFileMissingImport,
  ConfigFileImportsFromOutsideCheck,
  ModuleRequestUnresolvable,
] as const;

export const CONFIG_FILE_VIOLATION = Schema.Union(CONFIG_FILE_VIOLATIONS);

export const LINT_CONFIG_VIOLATION = Schema.Union([
  MalformedGrant,
  ...CONFIG_FILE_VIOLATIONS,
  LintConfigArgumentNotLiteral,
  LintConfigKeyRepeated,
]);

export class LintConfigRefused extends Schema.TaggedError<LintConfigRefused>()(
  "LintConfigRefused",
  { violations: Schema.Array(LINT_CONFIG_VIOLATION) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}

export class PackageManifestUnparsable extends Schema.TaggedError<PackageManifestUnparsable>()(
  "PackageManifestUnparsable",
  {
    location: Schema.String,
    reason: Schema.String,
  },
) {
  public override get message() {
    return `is not valid JSON: ${this.reason}`;
  }
}

export class PackageManifestNotObject extends Schema.TaggedError<PackageManifestNotObject>()(
  "PackageManifestNotObject",
  {
    location: Schema.String,
    reason: Schema.String,
  },
) {
  public override get message() {
    return `does not hold a JSON object: ${this.reason}`;
  }
}

export class PackageManifestUnreadable extends Schema.TaggedError<PackageManifestUnreadable>()(
  "PackageManifestUnreadable",
  {
    location: Schema.String,
    reason: Schema.String,
  },
) {
  public override get message() {
    return `cannot be read as a package.json whose name, if any, is a string: ${this.reason}`;
  }
}

export class CompetingFormatterConfig extends Schema.TaggedError<CompetingFormatterConfig>()(
  "CompetingFormatterConfig",
  { location: Schema.String },
) {
  public override get message() {
    return `competes with ${FORMAT_CONFIG_FILE}`;
  }
}

export class PackagePrettierField extends Schema.TaggedError<PackagePrettierField>()(
  "PackagePrettierField",
  { location: Schema.String },
) {
  public override get message() {
    return `has a "prettier" field, which competes with ${FORMAT_CONFIG_FILE}`;
  }
}

export class FormatConfigRefused extends Schema.TaggedError<FormatConfigRefused>()(
  "FormatConfigRefused",
  {
    violations: Schema.Array(CONFIG_FILE_VIOLATION),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}

export class FormatInputsRefused extends Schema.TaggedError<FormatInputsRefused>()(
  "FormatInputsRefused",
  {
    violations: Schema.Array(
      Schema.Union([
        CompetingFormatterConfig,
        PackagePrettierField,
        PackageManifestUnparsable,
        PackageManifestNotObject,
      ]),
    ),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}

export class SourceFileUnparsable extends Schema.TaggedError<SourceFileUnparsable>()(
  "SourceFileUnparsable",
  { file: Schema.String, line: Schema.optionalKey(Schema.Int), reason: Schema.String },
) {
  public get location() {
    return this.line === undefined ? this.file : `${this.file}:${this.line}`;
  }
  public override get message() {
    return `does not parse: ${this.reason}`;
  }
}

export class PackageManifestFieldInvalid extends Schema.TaggedError<PackageManifestFieldInvalid>()(
  "PackageManifestFieldInvalid",
  { path: Schema.String, reason: Schema.String },
) {
  public get location() {
    return this.path;
  }
  public override get message() {
    return `has a field of an unexpected type: ${this.reason}`;
  }
}

export class PackageNotInstalled extends Schema.TaggedError<PackageNotInstalled>()(
  "PackageNotInstalled",
  { packageName: Schema.String, packageDirectory: Schema.String, reason: Schema.String },
) {
  public override get message() {
    return `${this.packageName} does not resolve from ${this.packageDirectory}: ${this.reason}`;
  }
}

export class InstalledPackageHasNoBinary extends Schema.TaggedError<InstalledPackageHasNoBinary>()(
  "InstalledPackageHasNoBinary",
  { packageName: Schema.String, binaryName: Schema.String },
) {
  public override get message() {
    return `${this.packageName} declares no ${this.binaryName} binary in its package.json bin field`;
  }
}

export class ToolExited extends Schema.TaggedError<ToolExited>()("ToolExited", {
  program: Schema.String,
  command: Schema.String,
  code: Schema.Int,
  standardOutput: Schema.String,
  standardError: Schema.String,
}) {
  public override get message() {
    return [`${this.program} exited with code ${this.code}`, this.standardError]
      .filter((line) => line !== "")
      .join("\n");
  }
}

export class ToolNotStarted extends Schema.TaggedError<ToolNotStarted>()("ToolNotStarted", {
  command: Schema.String,
  reason: Schema.String,
}) {
  public override get message() {
    return `${this.command} did not start: ${this.reason}`;
  }
}

export class ToolNotStopped extends Schema.TaggedError<ToolNotStopped>()("ToolNotStopped", {
  command: Schema.String,
  reason: Schema.String,
}) {
  public override get message() {
    return `${this.command} could not be stopped: ${this.reason}`;
  }
}

export class ToolStoppedBySignal extends Schema.TaggedError<ToolStoppedBySignal>()(
  "ToolStoppedBySignal",
  { program: Schema.String, command: Schema.String, signal: Schema.String },
) {
  public override get message() {
    return `${this.program} was stopped by signal ${this.signal}`;
  }
}

export class ToolReportedViolations extends Schema.TaggedError<ToolReportedViolations>()(
  "ToolReportedViolations",
  { program: Schema.String, command: Schema.String, code: Schema.Int, count: Schema.Int },
) {
  public override get message() {
    return `${this.program} reported ${this.count} ${this.count === 1 ? "violation" : "violations"} and exited with code ${this.code}`;
  }
}

export class ToolReportUndecodable extends Schema.TaggedError<ToolReportUndecodable>()(
  "ToolReportUndecodable",
  { program: Schema.String, reason: Schema.String, report: Schema.String },
) {
  public override get message() {
    return [
      `${this.program} printed a report that does not decode: ${this.reason}`,
      this.report.replace(/\n+$/u, ""),
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
}

export class TypeScriptProjectFileMissing extends Schema.TaggedError<TypeScriptProjectFileMissing>()(
  "TypeScriptProjectFileMissing",
  { projectFile: Schema.String },
) {
  public get location() {
    return this.projectFile;
  }
  public override get message() {
    return `does not exist`;
  }
}

export const STRICT_OPTIONS = [
  "strict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
] as const;

export const REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT = {
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  allowImportingTsExtensions: true,
  noImplicitReturns: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noPropertyAccessFromIndexSignature: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  noCheck: false,
} as const;

export const BUILD_OUTPUT_OPTIONS = [
  "outDir",
  "declaration",
  "declarationDir",
  "emitDeclarationOnly",
] as const;

export const OPTIONS_TSC_LEAVES_UNSET: ReadonlySet<string> = new Set([
  "allowUnreachableCode",
  "allowUnusedLabels",
]);

export class LooseCompilerOption extends Schema.TaggedError<LooseCompilerOption>()(
  "LooseCompilerOption",
  {
    projectFile: Schema.String,
    option: Schema.Literals([
      ...STRICT_OPTIONS,
      ...Record.keys(REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT),
      "noEmit",
      "emitDeclarationOnly",
    ]),
    resolvedValue: Schema.optionalKey(Schema.Boolean),
  },
) {
  public get location() {
    return this.projectFile;
  }
  public override get message() {
    return this.resolvedValue === undefined
      ? `${this.option} is unset`
      : `${this.option} resolves to ${this.resolvedValue}`;
  }
}

export class BuildOutputCompilerOption extends Schema.TaggedError<BuildOutputCompilerOption>()(
  "BuildOutputCompilerOption",
  { projectFile: Schema.String, option: Schema.Literals(BUILD_OUTPUT_OPTIONS) },
) {
  public get location() {
    return this.projectFile;
  }
  public override get message() {
    return `${this.option} is set, but the package ships its TypeScript source and builds nothing`;
  }
}

export class ProjectReferencesUndecodable extends Schema.TaggedError<ProjectReferencesUndecodable>()(
  "ProjectReferencesUndecodable",
  { projectFile: Schema.String, reason: Schema.String },
) {
  public get location() {
    return this.projectFile;
  }
  public override get message() {
    return `references do not decode: ${this.reason}`;
  }
}

export class AbsoluteProjectReference extends Schema.TaggedError<AbsoluteProjectReference>()(
  "AbsoluteProjectReference",
  { projectFile: Schema.String, reference: Schema.String },
) {
  public get location() {
    return this.projectFile;
  }
  public override get message() {
    return `references ${this.reference} by an absolute path`;
  }
}

export class TypeScriptConfigUnparsable extends Schema.TaggedError<TypeScriptConfigUnparsable>()(
  "TypeScriptConfigUnparsable",
  { projectFile: Schema.String, reason: Schema.String },
) {
  public get location() {
    return this.projectFile;
  }
  public override get message() {
    return `does not parse as JSONC: ${this.reason}`;
  }
}

export class TypeScriptConfigViolations extends Schema.TaggedError<TypeScriptConfigViolations>()(
  "TypeScriptConfigViolations",
  {
    violations: Schema.Array(
      Schema.Union([
        TypeScriptProjectFileMissing,
        TypeScriptConfigUnparsable,
        ProjectReferencesUndecodable,
        AbsoluteProjectReference,
        LooseCompilerOption,
        BuildOutputCompilerOption,
      ]),
    ),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}

export class PackageExportsMixKeys extends Schema.TaggedError<PackageExportsMixKeys>()(
  "PackageExportsMixKeys",
  { path: Schema.String },
) {
  public get location() {
    return this.path;
  }
  public override get message() {
    return "has an exports object that mixes subpath keys starting with . and condition keys, which Node rejects";
  }
}

export class BunConfigInvalid extends Schema.TaggedError<BunConfigInvalid>()("BunConfigInvalid", {
  path: Schema.String,
  reason: Schema.String,
}) {
  public get location() {
    return this.path;
  }
  public override get message() {
    return `is not a bunfig.toml check can read: ${this.reason}`;
  }
}
