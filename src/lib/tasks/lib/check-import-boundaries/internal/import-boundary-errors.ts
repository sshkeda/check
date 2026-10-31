import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";
import { SCRIPTS_DIRECTORY, TEST_DIRECTORY } from "../../../../../shared/test-home-directories.ts";
import { MODULE_URL_USAGES } from "../../../shared/find-module-requests.ts";

export class ImportResolvesToNoFile extends Schema.TaggedError<ImportResolvesToNoFile>()(
  "ImportResolvesToNoFile",
  { location: Schema.String, specifier: Schema.String },
) {
  public override get message() {
    return `imports ${this.specifier}, which resolves to no file`;
  }
}

export class ImportOfMissingIgnoredFile extends Schema.TaggedError<ImportOfMissingIgnoredFile>()(
  "ImportOfMissingIgnoredFile",
  { location: Schema.String, specifier: Schema.String, missingPath: Schema.String },
) {
  public override get message() {
    return `imports ${this.specifier}, but ${this.missingPath} does not exist and is gitignored`;
  }
}

export class ImportCaseMismatch extends Schema.TaggedError<ImportCaseMismatch>()(
  "ImportCaseMismatch",
  { location: Schema.String, specifier: Schema.String, importedFile: Schema.String },
) {
  public override get message() {
    return `imports ${this.specifier}, which differs only in letter case from ${this.importedFile}`;
  }
}

export class CannotImportCrossed extends Schema.TaggedError<CannotImportCrossed>()(
  "CannotImportCrossed",
  {
    location: Schema.String,
    importedPath: Schema.String,
    grantPath: Schema.String,
    target: Schema.String,
  },
) {
  public override get message() {
    return `imports ${this.importedPath}, and ${this.grantPath} cannot import ${this.target}`;
  }
}

export class TestImported extends Schema.TaggedError<TestImported>()("TestImported", {
  location: Schema.String,
  importedPath: Schema.String,
}) {
  public override get message() {
    return `imports ${this.importedPath}, but only ${SCRIPTS_DIRECTORY}/ and ${TEST_DIRECTORY}/ may import ${TEST_DIRECTORY}/`;
  }
}

export class DevDependencyImported extends Schema.TaggedError<DevDependencyImported>()(
  "DevDependencyImported",
  { location: Schema.String, specifier: Schema.String, packageName: Schema.String },
) {
  public override get message() {
    return `imports ${this.specifier}, but package.json lists ${this.packageName} only in devDependencies, and src cannot import a dev dependency`;
  }
}

export class ModuleInternalsImported extends Schema.TaggedError<ModuleInternalsImported>()(
  "ModuleInternalsImported",
  {
    location: Schema.String,
    importedPath: Schema.String,
    module: Schema.String,
    kind: Schema.Literals(["module", "package"]),
  },
) {
  public override get message() {
    return `imports ${this.importedPath}, inside ${this.kind} ${this.module}/, from outside it`;
  }
}

export class PlainDirectoryImported extends Schema.TaggedError<PlainDirectoryImported>()(
  "PlainDirectoryImported",
  {
    location: Schema.String,
    importedPath: Schema.String,
    directory: Schema.String,
    parent: Schema.String,
  },
) {
  public override get message() {
    return `imports ${this.importedPath}, inside ${this.directory}/, which only ${this.parent}/ may import`;
  }
}

export class PrivateCodeImported extends Schema.TaggedError<PrivateCodeImported>()(
  "PrivateCodeImported",
  {
    location: Schema.String,
    importedPath: Schema.String,
    directory: Schema.String,
    module: Schema.String,
  },
) {
  public override get message() {
    return `imports ${this.importedPath}, which is private to ${this.module}/: only its index and files in ${this.directory}/ may import it`;
  }
}

export class ImportOutsidePackage extends Schema.TaggedError<ImportOutsidePackage>()(
  "ImportOutsidePackage",
  { location: Schema.String, specifier: Schema.String, importedFile: Schema.String },
) {
  public override get message() {
    return `imports ${this.specifier}, which resolves to ${this.importedFile} outside the package`;
  }
}

const MODULE_URL_USAGE_FACTS = {
  stored: "stores import.meta.url in a variable",
  computed: "builds a module URL from a computed path",
  base: "builds a module URL on a base other than import.meta.url itself",
  other: 'uses import.meta.url outside new URL("…", import.meta.url)',
} as const satisfies Readonly<Record<(typeof MODULE_URL_USAGES)[number], string>>;

export class ModuleUrlNotInline extends Schema.TaggedError<ModuleUrlNotInline>()(
  "ModuleUrlNotInline",
  { location: Schema.String, usage: Schema.Literals(MODULE_URL_USAGES) },
) {
  public override get message() {
    return MODULE_URL_USAGE_FACTS[this.usage];
  }
}

export class ModuleUrlPassedToFunction extends Schema.TaggedError<ModuleUrlPassedToFunction>()(
  "ModuleUrlPassedToFunction",
  { location: Schema.String, callee: Schema.String },
) {
  public override get message() {
    return `passes import.meta.url to ${this.callee}`;
  }
}

export class ModulePathFromDirectory extends Schema.TaggedError<ModulePathFromDirectory>()(
  "ModulePathFromDirectory",
  { location: Schema.String, property: Schema.String },
) {
  public override get message() {
    return `builds a module path from import.meta.${this.property}`;
  }
}

export const IMPORT_BOUNDARY_VIOLATION = Schema.Union([
  ModuleUrlNotInline,
  ModuleUrlPassedToFunction,
  ModulePathFromDirectory,
  ImportResolvesToNoFile,
  ImportOfMissingIgnoredFile,
  ImportCaseMismatch,
  ImportOutsidePackage,
  CannotImportCrossed,
  TestImported,
  DevDependencyImported,
  ModuleInternalsImported,
  PlainDirectoryImported,
  PrivateCodeImported,
]);

export class ImportBoundariesCrossed extends Schema.TaggedError<ImportBoundariesCrossed>()(
  "ImportBoundariesCrossed",
  {
    violations: Schema.Array(IMPORT_BOUNDARY_VIOLATION),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
