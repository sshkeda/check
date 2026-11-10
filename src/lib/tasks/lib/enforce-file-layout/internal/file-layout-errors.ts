import { Effect, Schema } from "effect";

import {
  TASK_MAIN_MEMBER,
  TASK_NAMESPACE_EXPORT,
  TASK_PACKAGE,
} from "../../../../../shared/bans-each-permission-lifts.ts";
import { LINT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import { listedViolations } from "../../../../../shared/format-reported-failures.ts";
import {
  fileNameOf,
  INTERNAL_DIRECTORY_NAME,
  LIBRARY_DIRECTORY_NAME,
  SHARED_DIRECTORY_NAME,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import { RedundantGrant } from "../../../../../shared/permission-grant-errors.ts";
import { DIRECTORY, PATCH } from "../../../../../shared/record-and-grant-permissions-by-path.ts";
import { SCRIPTS_DIRECTORY } from "../../../../../shared/test-home-directories.ts";
import { directoryOf } from "../../../shared/classify-files-by-role.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { PATCHED_DEPENDENCIES_FIELD } from "../../../shared/match-granted-patch-files.ts";
import {
  CHECK_PACKAGE,
  PackageManifestNotObject,
  PackageManifestUnparsable,
} from "../../../shared/project-config-and-tool-errors.ts";

export const DOCS_DIRECTORY = "docs";

export class NotKebabCase extends Schema.TaggedError<NotKebabCase>()("NotKebabCase", {
  location: Schema.String,
  segment: Schema.String,
}) {
  public override get message() {
    return `${this.segment} is not kebab-case`;
  }
}

export class MisplacedToolFile extends Schema.TaggedError<MisplacedToolFile>()(
  "MisplacedToolFile",
  {
    location: Schema.String,
    directories: Schema.Array(Schema.String),
  },
) {
  public override get message() {
    const locations = this.directories.map((directory) =>
      directory === "" ? "the package root" : `${directory}/`,
    );
    return `is a tool file that belongs in ${locations.join(" or ")}`;
  }
}

export class BunTestFileName extends Schema.TaggedError<BunTestFileName>()("BunTestFileName", {
  location: Schema.String,
}) {
  public override get message() {
    return "is named like a bun test";
  }
}

export class TopLevelNonScript extends Schema.TaggedError<TopLevelNonScript>()(
  "TopLevelNonScript",
  { location: Schema.String },
) {
  public override get message() {
    return `sits directly in ${SCRIPTS_DIRECTORY}/ and is not a TypeScript or JavaScript file`;
  }
}

export class TopLevelScriptWithoutMain extends Schema.TaggedError<TopLevelScriptWithoutMain>()(
  "TopLevelScriptWithoutMain",
  { location: Schema.String },
) {
  public override get message() {
    return `sits directly in ${SCRIPTS_DIRECTORY}/ and neither calls ${TASK_NAMESPACE_EXPORT}.${TASK_MAIN_MEMBER} imported from ${TASK_PACKAGE} nor has a default export`;
  }
}

const SCRIPT_ENTRY_POINTS = ["main-guard", "default-export"] as const;

const STATEMENTS_A_SCRIPT_MAY_HOLD = {
  "main-guard": `an import and if (import.meta.main) { ${TASK_NAMESPACE_EXPORT}.${TASK_MAIN_MEMBER}(task); }`,
  "default-export": "an import and export default task",
} satisfies Record<(typeof SCRIPT_ENTRY_POINTS)[number], string>;

export class TopLevelScriptHoldsOtherStatement extends Schema.TaggedError<TopLevelScriptHoldsOtherStatement>()(
  "TopLevelScriptHoldsOtherStatement",
  { location: Schema.String, entryPoint: Schema.Literals(SCRIPT_ENTRY_POINTS) },
) {
  public override get message() {
    return `holds a statement other than ${STATEMENTS_A_SCRIPT_MAY_HOLD[this.entryPoint]}`;
  }
}

export class TopLevelScriptWithMainAndDefaultExport extends Schema.TaggedError<TopLevelScriptWithMainAndDefaultExport>()(
  "TopLevelScriptWithMainAndDefaultExport",
  { location: Schema.String },
) {
  public override get message() {
    return `calls ${TASK_NAMESPACE_EXPORT}.${TASK_MAIN_MEMBER} and also has a default export. Keep one of them`;
  }
}

export class LibraryDirectory extends Schema.TaggedError<LibraryDirectory>()("LibraryDirectory", {
  location: Schema.String,
}) {
  public override get message() {
    return `is a ${LIBRARY_DIRECTORY_NAME}/ directory that is not directly in a module`;
  }
}

export class DirectoryOutsideModuleLayout extends Schema.TaggedError<DirectoryOutsideModuleLayout>()(
  "DirectoryOutsideModuleLayout",
  { location: Schema.String, module: Schema.String },
) {
  public override get message() {
    return `is a directory in the module ${this.module}/ other than ${INTERNAL_DIRECTORY_NAME}/, ${SHARED_DIRECTORY_NAME}/ or ${LIBRARY_DIRECTORY_NAME}/. Move it to ${this.module}/${LIBRARY_DIRECTORY_NAME}/${fileNameOf(this.location)}/`;
  }
}

export class ModuleWithoutIndex extends Schema.TaggedError<ModuleWithoutIndex>()(
  "ModuleWithoutIndex",
  { location: Schema.String },
) {
  public override get message() {
    return `is a directory in ${directoryOf(this.location)}/ without an index.ts or index.tsx`;
  }
}

export class ModuleWithLayoutDirectoryName extends Schema.TaggedError<ModuleWithLayoutDirectoryName>()(
  "ModuleWithLayoutDirectoryName",
  { location: Schema.String },
) {
  public override get message() {
    return `is a module in ${directoryOf(this.location)}/ named ${INTERNAL_DIRECTORY_NAME}, ${SHARED_DIRECTORY_NAME} or ${LIBRARY_DIRECTORY_NAME}`;
  }
}

export class FileInLibraryDirectory extends Schema.TaggedError<FileInLibraryDirectory>()(
  "FileInLibraryDirectory",
  { location: Schema.String },
) {
  public override get message() {
    return `is a file directly in ${directoryOf(this.location)}/`;
  }
}

export class DirectoryInInternalOrShared extends Schema.TaggedError<DirectoryInInternalOrShared>()(
  "DirectoryInInternalOrShared",
  { location: Schema.String, directory: Schema.String },
) {
  public override get message() {
    return `holds the directory ${this.directory}/`;
  }
}

export class IndexInInternalOrShared extends Schema.TaggedError<IndexInInternalOrShared>()(
  "IndexInInternalOrShared",
  { location: Schema.String },
) {
  public override get message() {
    return `is an index file directly in ${fileNameOf(directoryOf(this.location))}/`;
  }
}

export class SourceOutsideInternalOrShared extends Schema.TaggedError<SourceOutsideInternalOrShared>()(
  "SourceOutsideInternalOrShared",
  { location: Schema.String },
) {
  public override get message() {
    return "is a non-index source file outside internal/ or shared/";
  }
}

export class RetiredWordInPath extends Schema.TaggedError<RetiredWordInPath>()(
  "RetiredWordInPath",
  { location: Schema.String, word: Schema.String },
) {
  public override get message() {
    return `uses the retired word ${this.word}`;
  }
}

export class DirectoryHoldsOnlyADirectory extends Schema.TaggedError<DirectoryHoldsOnlyADirectory>()(
  "DirectoryHoldsOnlyADirectory",
  { location: Schema.String, child: Schema.String },
) {
  public override get message() {
    return `holds only the directory ${this.child}/`;
  }
}

export class DuplicateFileName extends Schema.TaggedError<DuplicateFileName>()(
  "DuplicateFileName",
  { location: Schema.String, otherPaths: Schema.Array(Schema.String), scope: Schema.String },
) {
  public override get message() {
    return `has the same file name as ${this.otherPaths.join(", ")} in ${this.scope === "" ? "the package root" : `${this.scope}/`}`;
  }
}

export class PackageScriptsField extends Schema.TaggedError<PackageScriptsField>()(
  "PackageScriptsField",
  { location: Schema.String },
) {
  public override get message() {
    return 'has a "scripts" field';
  }
}

export class DependencyOutsideRepository extends Schema.TaggedError<DependencyOutsideRepository>()(
  "DependencyOutsideRepository",
  { location: Schema.String, field: Schema.String, specifier: Schema.String },
) {
  public override get message() {
    return `${this.field} points to ${this.specifier}, outside the repository`;
  }
}

export const moduleDirectoryNamedBy = (subpath: string) =>
  subpath
    .slice("./".length)
    .split("/")
    .map((name) => `${LIBRARY_DIRECTORY_NAME}/${name}`)
    .join("/");

export class ExportPathMismatch extends Schema.TaggedError<ExportPathMismatch>()(
  "ExportPathMismatch",
  { location: Schema.String, field: Schema.String, target: Schema.String, subpath: Schema.String },
) {
  public override get message() {
    const index =
      this.subpath === "." ? "the root index" : `${moduleDirectoryNamedBy(this.subpath)}/index`;
    return `${this.field} points to ${this.target}, which is not ${index}`;
  }
}

export class PackageEntryNotTypeScript extends Schema.TaggedError<PackageEntryNotTypeScript>()(
  "PackageEntryNotTypeScript",
  { location: Schema.String, field: Schema.String, target: Schema.String },
) {
  public override get message() {
    return `${this.field} points to ${this.target}, which is not a TypeScript source file`;
  }
}

export class RepositoryRootNotFound extends Schema.TaggedError<RepositoryRootNotFound>()(
  "RepositoryRootNotFound",
  { directory: Schema.String, reason: Schema.String },
) {
  public override get message() {
    return `git found no repository root for ${this.directory}, so package.json dependencies cannot be told inside or outside it: ${this.reason}`;
  }
}

export class UngrantedDocument extends Schema.TaggedError<UngrantedDocument>()(
  "UngrantedDocument",
  { location: Schema.String },
) {
  public override get message() {
    return `is a document that ${LINT_CONFIG_FILE} does not allow`;
  }
}

export class UngrantedDirectory extends Schema.TaggedError<UngrantedDirectory>()(
  "UngrantedDirectory",
  { location: Schema.String },
) {
  public override get message() {
    return `is a directory outside the default layout that ${LINT_CONFIG_FILE} does not allow`;
  }
}

export class DirectoryGrantOnFile extends Schema.TaggedError<DirectoryGrantOnFile>()(
  "DirectoryGrantOnFile",
  {
    path: Schema.String,
    location: Schema.Literal(LINT_CONFIG_FILE).pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed(LINT_CONFIG_FILE)),
    ),
  },
) {
  public override get message() {
    return `${this.path} is granted ${DIRECTORY}, but is a file`;
  }
}

export class CheckOrTaskPatched extends Schema.TaggedError<CheckOrTaskPatched>()(
  "CheckOrTaskPatched",
  { location: Schema.String, dependency: Schema.String, patchPath: Schema.String },
) {
  public override get message() {
    return `patches ${this.dependency} with ${this.patchPath}; patches to ${CHECK_PACKAGE} or ${TASK_PACKAGE} are forbidden even when granted`;
  }
}

export class PatchNotGranted extends Schema.TaggedError<PatchNotGranted>()("PatchNotGranted", {
  location: Schema.String,
  dependency: Schema.String,
  patchPath: Schema.String,
}) {
  public override get message() {
    return `patches ${this.dependency} with ${this.patchPath}, which ${LINT_CONFIG_FILE} doesn't grant ${PATCH}`;
  }
}

export class UnlistedPatchGranted extends Schema.TaggedError<UnlistedPatchGranted>()(
  "UnlistedPatchGranted",
  {
    path: Schema.String,
    location: Schema.Literal(LINT_CONFIG_FILE).pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed(LINT_CONFIG_FILE)),
    ),
  },
) {
  public override get message() {
    return `${this.path} is granted ${PATCH}, but ${PACKAGE_MANIFEST_FILE} doesn't list it in ${PATCHED_DEPENDENCIES_FIELD}`;
  }
}

export class PatchedDependenciesMalformed extends Schema.TaggedError<PatchedDependenciesMalformed>()(
  "PatchedDependenciesMalformed",
  { location: Schema.String, reason: Schema.String },
) {
  public override get message() {
    return `has a ${PATCHED_DEPENDENCIES_FIELD} field that isn't an object of patch paths: ${this.reason}`;
  }
}

export class GrantedPathMissing extends Schema.TaggedError<GrantedPathMissing>()(
  "GrantedPathMissing",
  {
    path: Schema.String,
    location: Schema.Literal(LINT_CONFIG_FILE).pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed(LINT_CONFIG_FILE)),
    ),
  },
) {
  public override get message() {
    return `${this.path} is listed but is not a repository file or directory`;
  }
}

export class CannotImportTargetMissing extends Schema.TaggedError<CannotImportTargetMissing>()(
  "CannotImportTargetMissing",
  {
    path: Schema.String,
    target: Schema.String,
    location: Schema.Literal(LINT_CONFIG_FILE).pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed(LINT_CONFIG_FILE)),
    ),
  },
) {
  public override get message() {
    return `${this.target} is in cannotImport of ${this.path} but is not a repository file or directory`;
  }
}

export class DirectoryGrantedPermissions extends Schema.TaggedError<DirectoryGrantedPermissions>()(
  "DirectoryGrantedPermissions",
  {
    path: Schema.String,
    location: Schema.Literal(LINT_CONFIG_FILE).pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed(LINT_CONFIG_FILE)),
    ),
  },
) {
  public override get message() {
    return `${this.path} is a directory but is granted file permissions or services`;
  }
}

const MISPLACEMENT_PLACES = ["root-task-script", "root-code-file", "docs-non-markdown"] as const;

const MISPLACEMENTS = {
  "root-task-script": "is a task script at the package root",
  "root-code-file": "is code at the package root",
  "docs-non-markdown": `is not markdown but sits in ${DOCS_DIRECTORY}/`,
} satisfies Record<(typeof MISPLACEMENT_PLACES)[number], string>;

export class MisplacedAtPackageRoot extends Schema.TaggedError<MisplacedAtPackageRoot>()(
  "MisplacedAtPackageRoot",
  { location: Schema.String, place: Schema.Literals(MISPLACEMENT_PLACES) },
) {
  public override get message() {
    return MISPLACEMENTS[this.place];
  }
}

export class FileLayoutViolations extends Schema.TaggedError<FileLayoutViolations>()(
  "FileLayoutViolations",
  {
    violations: Schema.Array(
      Schema.Union([
        NotKebabCase,
        MisplacedToolFile,
        BunTestFileName,
        TopLevelNonScript,
        TopLevelScriptWithoutMain,
        TopLevelScriptHoldsOtherStatement,
        TopLevelScriptWithMainAndDefaultExport,
        LibraryDirectory,
        DirectoryOutsideModuleLayout,
        ModuleWithoutIndex,
        ModuleWithLayoutDirectoryName,
        FileInLibraryDirectory,
        DirectoryHoldsOnlyADirectory,
        DirectoryInInternalOrShared,
        IndexInInternalOrShared,
        SourceOutsideInternalOrShared,
        RetiredWordInPath,
        DuplicateFileName,
        PackageManifestUnparsable,
        PackageManifestNotObject,
        PackageScriptsField,
        DependencyOutsideRepository,
        ExportPathMismatch,
        PackageEntryNotTypeScript,
        UngrantedDocument,
        UngrantedDirectory,
        DirectoryGrantOnFile,
        CheckOrTaskPatched,
        PatchNotGranted,
        UnlistedPatchGranted,
        PatchedDependenciesMalformed,
        GrantedPathMissing,
        CannotImportTargetMissing,
        DirectoryGrantedPermissions,
        RedundantGrant,
        MisplacedAtPackageRoot,
      ]),
    ),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
