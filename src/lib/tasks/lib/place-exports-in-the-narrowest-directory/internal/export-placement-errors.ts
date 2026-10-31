import { Effect, Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";
import {
  INTERNAL_DIRECTORY_NAME,
  LIBRARY_DIRECTORY_NAME,
  SHARED_DIRECTORY_NAME,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import { SCRIPTS_DIRECTORY } from "../../../../../shared/test-home-directories.ts";
import { directoryOf, joinedWithAnd } from "../../../shared/classify-files-by-role.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import {
  PackageManifestFieldInvalid,
  SourceFileUnparsable,
} from "../../../shared/project-config-and-tool-errors.ts";

export class UnusedExport extends Schema.TaggedError<UnusedExport>()("UnusedExport", {
  location: Schema.String,
  exportName: Schema.String,
  unreachableUser: Schema.optionalKey(Schema.String),
}) {
  public override get message() {
    if (this.unreachableUser !== undefined) {
      return `export ${this.exportName} is used only by unreached code, such as ${this.unreachableUser}`;
    }
    return `export ${this.exportName} is used by nothing`;
  }
}

export class TestOnlyExport extends Schema.TaggedError<TestOnlyExport>()("TestOnlyExport", {
  location: Schema.String,
  exportName: Schema.String,
}) {
  public override get message() {
    return `export ${this.exportName} is used only by tests`;
  }
}

const UNCOUNTED_USERS = "outside tests and unreached code";

export class FileBesideSubdirectories extends Schema.TaggedError<FileBesideSubdirectories>()(
  "FileBesideSubdirectories",
  { location: Schema.String },
) {
  public override get message() {
    return `sits directly in ${directoryOf(this.location)}/, which has subdirectories that hold code`;
  }
}

export class FileOutsideModuleLayout extends Schema.TaggedError<FileOutsideModuleLayout>()(
  "FileOutsideModuleLayout",
  { location: Schema.String, module: Schema.String },
) {
  public override get message() {
    const directory = directoryOf(this.location);
    return directory === this.module
      ? `sits directly in the module ${this.module}/, not in its ${INTERNAL_DIRECTORY_NAME}/ or ${SHARED_DIRECTORY_NAME}/`
      : `sits in ${directory}/, which is inside the module ${this.module}/ but is not its ${INTERNAL_DIRECTORY_NAME}/, its ${SHARED_DIRECTORY_NAME}/ or a module in its ${LIBRARY_DIRECTORY_NAME}/`;
  }
}

export class SharedFileWithOneUser extends Schema.TaggedError<SharedFileWithOneUser>()(
  "SharedFileWithOneUser",
  {
    location: Schema.String,
    module: Schema.String,
    part: Schema.optionalKey(Schema.String),
    through: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  public override get message() {
    const users =
      this.part === undefined
        ? `no submodule of ${this.module}/ uses it`
        : `only ${this.part}/ uses it`;
    const through =
      this.through === undefined ? "" : `, counting the users of ${joinedWithAnd(this.through)}`;
    return `is in ${this.module}/${SHARED_DIRECTORY_NAME}/, but ${users} ${UNCOUNTED_USERS}${through}`;
  }
}

export class TestNotRun extends Schema.TaggedError<TestNotRun>()("TestNotRun", {
  location: Schema.String,
}) {
  public override get message() {
    return `is a test that no file directly in ${SCRIPTS_DIRECTORY}/ reaches through its imports`;
  }
}

export class PackageEntryWithoutSource extends Schema.TaggedError<PackageEntryWithoutSource>()(
  "PackageEntryWithoutSource",
  {
    entry: Schema.String,
    location: Schema.Literal(PACKAGE_MANIFEST_FILE).pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed(PACKAGE_MANIFEST_FILE)),
    ),
  },
) {
  public override get message() {
    return `lists the entry ${this.entry}, which maps to no source file through any tsconfig outDir and rootDir`;
  }
}

export class ImportUnresolvableInTheImportBoundaryCheck extends Schema.TaggedError<ImportUnresolvableInTheImportBoundaryCheck>()(
  "ImportUnresolvableInTheImportBoundaryCheck",
  { request: Schema.String, importingFile: Schema.String },
) {
  public override get message() {
    return `could not resolve ${this.request}`;
  }
}

export class ExportPlacementViolations extends Schema.TaggedError<ExportPlacementViolations>()(
  "ExportPlacementViolations",
  {
    violations: Schema.Array(
      Schema.Union([
        UnusedExport,
        TestOnlyExport,
        FileBesideSubdirectories,
        FileOutsideModuleLayout,
        SharedFileWithOneUser,
        TestNotRun,
        PackageEntryWithoutSource,
        PackageManifestFieldInvalid,
        SourceFileUnparsable,
      ]),
    ),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
