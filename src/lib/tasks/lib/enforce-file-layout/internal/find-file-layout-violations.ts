import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option, Path, Predicate, References, Result, Schema } from "effect";
import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Expression, ParseResult, Statement } from "oxc-parser";

import {
  TASK_PACKAGE,
  TASK_NAMESPACE_EXPORT,
  TASK_MAIN_MEMBER,
} from "../../../../../shared/bans-each-permission-lifts.ts";
import { retiredWordIn } from "../../../../../shared/find-retired-words.ts";
import {
  isEntryFileName,
  fileNameOf,
  isWithin,
  LAYOUT_DIRECTORY_NAMES,
  LIBRARY_DIRECTORY_NAME,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import {
  cannotImportPermission,
  RedundantGrant,
} from "../../../../../shared/permission-grant-errors.ts";
import {
  generatedPathsOf,
  DIRECTORY,
  FILE_TYPE,
  isMarkdown,
  normalizedPath,
  PATCH,
} from "../../../../../shared/record-and-grant-permissions-by-path.ts";
import type { PERMISSION_NAMES } from "../../../../../shared/record-and-grant-permissions-by-path.ts";
import {
  SCRIPTS_DIRECTORY,
  SOURCE_DIRECTORY,
  TEST_DIRECTORY,
} from "../../../../../shared/test-home-directories.ts";
import {
  MODULE_ROOT_DIRECTORIES,
  enclosingDirectoriesOf,
  isRootSupportFile,
  repeatsSourceNeverImportsScripts,
  moduleDirectoriesAmong,
  isTopLevelScript,
  isScript,
  isDeclarationFile,
  isUnderTestDirectory,
  isPackageManifest,
  directoryOf,
  directoriesNestedInLayoutDirectoriesOf,
} from "../../../shared/classify-files-by-role.ts";
import { lineNumbersIn } from "../../../shared/count-the-line-of-an-offset.ts";
import { listedBinaryFilesOf } from "../../../shared/find-installed-package-binaries.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { isInsideAnyDirectory, listedPackageFiles } from "../../../shared/list-package-files.ts";
import { loadedLintConfigIn } from "../../../shared/load-the-lint-config.ts";
import {
  bunPatchFileNameOf,
  isGrantedPatchFile,
  listedPatchesOf,
  patchedDependenciesOf,
  rootManifestIn,
} from "../../../shared/match-granted-patch-files.ts";
import { CHECK_PACKAGE } from "../../../shared/project-config-and-tool-errors.ts";
import {
  JSON_OBJECT,
  packageManifestObject,
} from "../../../shared/read-package-manifest-object.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import { toolFileOf, toolFileIsPlaced } from "../../../shared/tool-file-locations.ts";
import {
  BunTestFileName,
  CannotImportTargetMissing,
  CheckOrTaskPatched,
  DOCS_DIRECTORY,
  FileLayoutViolations,
  DirectoryGrantedPermissions,
  DirectoryGrantOnFile,
  DependencyOutsideRepository,
  DirectoryHoldsOnlyADirectory,
  RepositoryRootNotFound,
  DuplicateFileName,
  GrantedPathMissing,
  LibraryDirectory,
  DirectoryInInternalOrShared,
  IndexInInternalOrShared,
  SourceOutsideInternalOrShared,
  MisplacedAtPackageRoot,
  RetiredWordInPath,
  NotKebabCase,
  PackageScriptsField,
  PatchedDependenciesMalformed,
  PatchNotGranted,
  MisplacedToolFile,
  TopLevelNonScript,
  TopLevelScriptHoldsOtherStatement,
  TopLevelScriptWithMainAndDefaultExport,
  TopLevelScriptWithoutMain,
  UngrantedDocument,
  UngrantedDirectory,
  UnlistedPatchGranted,
} from "./file-layout-errors.ts";
import {
  exportPathMismatches,
  packageEntriesNotTypeScript,
} from "./find-export-path-mismatches.ts";
import {
  directoriesOutsideModuleLayoutAmong,
  isLibraryDirectoryOfAModule,
  isModuleDirectory,
  moduleLayoutViolations,
  modulesWithLayoutDirectoryNamesAmong,
  moduleWithLayoutDirectoryNameViolations,
} from "./find-module-layout-violations.ts";
import { taskImportsIn, isTaskLayoutFile } from "./resolve-task-imports.ts";

const KEBAB_CASE_PART = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BUN_TEST_FILE_EXTENSION = /\.(?:test|spec)(?<extension>\.[^.]+)$/u;
const DIRECTORY_AND_FILE = 2;

const GRANTS_OF_A_REFUSED_CONFIG_ARE_REPORTED_BY_THE_LINT_CONFIG_TASK = Effect.succeedNone;

const isKebabCaseSegment = (segment: string) =>
  toolFileOf(segment) !== undefined ||
  segment
    .replace(/^\./u, "")
    .split(".")
    .every((part) => KEBAB_CASE_PART.test(part));

const isNamedLikeABunTest = (fileName: string) => {
  const extension = BUN_TEST_FILE_EXTENSION.exec(fileName.toLowerCase())?.groups?.["extension"];
  return extension !== undefined && isScript(extension);
};

export const pathViolations = (path: string, isNamedByBunPatch = false) => {
  const violations: (BunTestFileName | MisplacedToolFile | NotKebabCase | TopLevelNonScript)[] = [];
  const segments = path.split("/");
  const fileName = fileNameOf(path);
  const tool = toolFileOf(path);
  const misnamed = segments.find(
    (segment, index) =>
      !isKebabCaseSegment(segment) && !(isNamedByBunPatch && index === segments.length - 1),
  );
  if (misnamed !== undefined) {
    violations.push(new NotKebabCase({ location: path, segment: misnamed }));
  }
  const isMisplacedTool = tool?.directories !== undefined && !toolFileIsPlaced(path);
  if (isMisplacedTool) {
    violations.push(new MisplacedToolFile({ location: path, directories: tool.directories }));
  }
  if (isNamedLikeABunTest(fileName)) {
    violations.push(new BunTestFileName({ location: path }));
  }
  const isPlacedNonDocumentTool = tool !== undefined && toolFileIsPlaced(path) && !isMarkdown(path);
  const isNonScriptDirectlyInScriptsDirectory =
    segments.length === DIRECTORY_AND_FILE &&
    segments[0] === SCRIPTS_DIRECTORY &&
    !isScript(fileName.toLowerCase()) &&
    !isMisplacedTool &&
    !isPlacedNonDocumentTool;
  if (isNonScriptDirectlyInScriptsDirectory) {
    violations.push(new TopLevelNonScript({ location: path }));
  }
  return violations;
};

const directTaskImports = (parsed: ParseResult) =>
  new Map(
    parsed.module.staticImports
      .filter((declaration) => declaration.moduleRequest.value === TASK_PACKAGE)
      .flatMap((declaration) =>
        declaration.entries
          .filter((entry) => !entry.isType)
          .map(
            (entry) =>
              [
                entry.localName.value,
                entry.importName.kind === "NamespaceObject" ? [] : [entry.importName.name ?? ""],
              ] as const,
          ),
      ),
  );

const callsTaskMember = (
  parsed: ParseResult,
  member: string,
  imports: ReadonlyMap<string, readonly string[]>,
) => {
  const calls: CallExpression[] = [];
  const aliases = new Map<string, Expression>();
  new Visitor({
    CallExpression(node) {
      calls.push(node);
    },
    VariableDeclarator({ id, init: initializer }) {
      const isNamedInitializer = id.type === "Identifier" && initializer !== null;
      if (isNamedInitializer) {
        aliases.set(id.name, initializer);
      }
    },
  }).visit(parsed.program);
  const taskReference = (
    expression: Expression,
    seen: ReadonlySet<string> = new Set(),
  ): readonly string[] | undefined => {
    if (expression.type === "Identifier") {
      const imported = imports.get(expression.name);
      if (imported !== undefined) {
        return imported;
      }
      const alias = aliases.get(expression.name);
      const isUnfollowedAlias = alias !== undefined && !seen.has(expression.name);
      return isUnfollowedAlias
        ? taskReference(alias, new Set([...seen, expression.name]))
        : undefined;
    }
    const isStaticMember =
      expression.type === "MemberExpression" &&
      !expression.computed &&
      expression.property.type === "Identifier";
    if (!isStaticMember) {
      return;
    }
    const object = taskReference(expression.object, seen);
    return object === undefined ? undefined : [...object, expression.property.name];
  };
  return calls.some(
    ({ callee }) => taskReference(callee)?.join(".") === `${TASK_NAMESPACE_EXPORT}.${member}`,
  );
};

const importedMemberPath = (
  expression: Expression,
  imports: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined => {
  if (expression.type === "Identifier") {
    return imports.get(expression.name);
  }
  const isStaticMember =
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier";
  if (!isStaticMember) {
    return;
  }
  const object = importedMemberPath(expression.object, imports);
  return object === undefined ? undefined : [...object, expression.property.name];
};

const isMainGuard = (statement: Statement, imports: ReadonlyMap<string, readonly string[]>) => {
  if (statement.type !== "IfStatement") {
    return false;
  }
  const { test, consequent, alternate } = statement;
  const testsImportMetaMain =
    test.type === "MemberExpression" &&
    !test.computed &&
    test.object.type === "MetaProperty" &&
    test.object.meta.name === "import" &&
    test.object.property.name === "meta" &&
    test.property.type === "Identifier" &&
    test.property.name === "main";
  const [only, ...others] = consequent.type === "BlockStatement" ? consequent.body : [];
  const expression = only?.type === "ExpressionStatement" ? only.expression : undefined;
  const call = expression?.type === "CallExpression" ? expression : undefined;
  const [task, ...otherArguments] = call?.arguments ?? [];
  const runsOneNamedTask =
    call !== undefined &&
    others.length === 0 &&
    otherArguments.length === 0 &&
    task?.type === "Identifier" &&
    importedMemberPath(call.callee, imports)?.join(".") ===
      `${TASK_NAMESPACE_EXPORT}.${TASK_MAIN_MEMBER}`;
  return testsImportMetaMain && alternate === null && runsOneNamedTask;
};

const isDefaultExport = (statement: Statement) =>
  statement.type === "ExportDefaultDeclaration" &&
  statement.declaration.type !== "TSInterfaceDeclaration";

const statementsOtherThanImports = (parsed: ParseResult) =>
  parsed.program.body.filter((statement) => statement.type !== "ImportDeclaration");

const statementsOtherThanImportsAndMain = (
  parsed: ParseResult,
  imports: ReadonlyMap<string, readonly string[]>,
) => {
  const nonImports = statementsOtherThanImports(parsed);
  const firstGuard = nonImports.findIndex((statement) => isMainGuard(statement, imports));
  return nonImports.filter((_statement, index) => index !== firstGuard);
};

const mainScriptViolations = (
  path: string,
  text: string,
  parsed: ParseResult,
  imports: ReadonlyMap<string, readonly string[]>,
) => {
  const lineAt = lineNumbersIn(text);
  return statementsOtherThanImportsAndMain(parsed, imports).map((statement) => {
    const location = `${path}:${lineAt(statement.start)}`;
    return isDefaultExport(statement)
      ? new TopLevelScriptWithMainAndDefaultExport({ location })
      : new TopLevelScriptHoldsOtherStatement({ location, entryPoint: "main-guard" });
  });
};

const defaultExportScriptViolations = (path: string, text: string, parsed: ParseResult) => {
  const lineAt = lineNumbersIn(text);
  return statementsOtherThanImports(parsed)
    .filter((statement) => !isDefaultExport(statement))
    .map(
      (statement) =>
        new TopLevelScriptHoldsOtherStatement({
          location: `${path}:${lineAt(statement.start)}`,
          entryPoint: "default-export",
        }),
    );
};

export const sourceViolations = (
  path: string,
  text: string,
  resolvedImports?: ReadonlyMap<string, readonly string[]>,
  isListedUnderBin = false,
) => {
  const violations: (
    | MisplacedAtPackageRoot
    | SourceOutsideInternalOrShared
    | TopLevelScriptHoldsOtherStatement
    | TopLevelScriptWithMainAndDefaultExport
    | TopLevelScriptWithoutMain
  )[] = [];
  const isMisplacedTool = toolFileOf(path) !== undefined && !toolFileIsPlaced(path);
  if (isMisplacedTool) {
    return violations;
  }

  const isSourceOutsideModuleImplementation =
    MODULE_ROOT_DIRECTORIES.has(path.split("/")[0] ?? "") &&
    !isTopLevelScript(path) &&
    !isLibraryDirectoryOfAModule(directoryOf(path)) &&
    !isEntryFileName(fileNameOf(path)) &&
    !isDeclarationFile(path) &&
    !enclosingDirectoriesOf(path).some((directory) =>
      LAYOUT_DIRECTORY_NAMES.has(fileNameOf(directory)),
    );
  if (isSourceOutsideModuleImplementation) {
    violations.push(new SourceOutsideInternalOrShared({ location: path }));
  }

  const parsed = parseSync(path, text);
  const imports = resolvedImports ?? directTaskImports(parsed);
  const isRootCodeFile = !path.includes("/") && !isRootSupportFile(path);
  if (isRootCodeFile) {
    violations.push(
      new MisplacedAtPackageRoot({
        location: path,
        place: callsTaskMember(parsed, TASK_MAIN_MEMBER, imports)
          ? "root-task-script"
          : "root-code-file",
      }),
    );
  }
  const isTaskScript = isTopLevelScript(path) && !isListedUnderBin;
  if (!isTaskScript) {
    return violations;
  }
  const callsMain = callsTaskMember(parsed, TASK_MAIN_MEMBER, imports);
  const hasDefaultExport = parsed.program.body.some((statement) => isDefaultExport(statement));
  if (callsMain) {
    violations.push(...mainScriptViolations(path, text, parsed, imports));
  } else if (hasDefaultExport) {
    violations.push(...defaultExportScriptViolations(path, text, parsed));
  } else {
    violations.push(new TopLevelScriptWithoutMain({ location: path }));
  }
  return violations;
};

const directoryNameWords = (directoryName: string) =>
  directoryName.replace(/^\./u, "").split(/[-_.]/u);

const nameViolationsOf = (path: string, words: readonly string[]) => {
  const retired = retiredWordIn(words);
  return retired === undefined ? [] : [new RetiredWordInPath({ location: path, ...retired })];
};

const distinctDirectoriesOf = (paths: readonly string[]) => [
  ...new Set(paths.flatMap((path) => enclosingDirectoriesOf(path))),
];

const outermostDirectoriesOf = (directories: readonly string[]) =>
  directories.filter((directory) => !isInsideAnyDirectory(directory, directories));

const shapeViolationsOf = (paths: readonly string[]) => {
  const directories = distinctDirectoriesOf(paths);
  const directoriesOutsideModuleLayout = directoriesOutsideModuleLayoutAmong(paths);
  return [
    ...moduleLayoutViolations(paths),
    ...directories
      .filter((directory) => {
        const isLibraryDirectoryOutsideAModule =
          directory.endsWith(`/${LIBRARY_DIRECTORY_NAME}`) &&
          !isModuleDirectory(directoryOf(directory));
        return (
          isLibraryDirectoryOutsideAModule &&
          !isInsideAnyDirectory(directory, directoriesOutsideModuleLayout)
        );
      })
      .map((directory) => new LibraryDirectory({ location: directory })),
    ...[
      ...new Set(
        paths
          .filter((path) => isScript(path) && !isUnderTestDirectory(path))
          .flatMap((path) => directoriesNestedInLayoutDirectoriesOf(path)),
      ),
    ].map(
      (directory) =>
        new DirectoryInInternalOrShared({ location: directoryOf(directory), directory }),
    ),
    ...paths
      .filter(
        (path) =>
          isEntryFileName(fileNameOf(path)) &&
          LAYOUT_DIRECTORY_NAMES.has(fileNameOf(directoryOf(path))),
      )
      .map((path) => new IndexInInternalOrShared({ location: path })),
  ];
};

export const directoryShapeViolations = (paths: readonly string[]) => {
  const modulesWithLayoutDirectoryNames = modulesWithLayoutDirectoryNamesAmong(paths);
  return [
    ...moduleWithLayoutDirectoryNameViolations(paths),
    ...shapeViolationsOf(paths).filter(
      ({ location }) =>
        !modulesWithLayoutDirectoryNames.some((module) => isWithin(location, module)),
    ),
  ];
};

const PACKAGE_ROOT_SCOPE = "";
const PACKAGE_ROOT_DIRECTORIES: ReadonlySet<string> = new Set([
  SOURCE_DIRECTORY,
  SCRIPTS_DIRECTORY,
  TEST_DIRECTORY,
  DOCS_DIRECTORY,
]);

const isRootDirectoryOutsideTheLayout = (directory: string) =>
  !directory.includes("/") && !PACKAGE_ROOT_DIRECTORIES.has(directory);

const directoriesExemptFromShapeRules = (
  directories: Iterable<string>,
  grants: Effect.Success<ReturnType<typeof loadedLintConfigIn>>,
) =>
  [...directories].filter(
    (directory) =>
      isRootDirectoryOutsideTheLayout(directory) &&
      grants.some((grant) => grant.path === directory && grant.allow.includes(DIRECTORY)),
  );

export const directoriesHoldingOnlyADirectory = (
  paths: readonly string[],
  nestedPackageDirectories: readonly string[],
) => {
  const outermostPackageDirectories = outermostDirectoriesOf(nestedPackageDirectories);
  const directories = new Set([
    ...distinctDirectoriesOf([...paths, ...outermostPackageDirectories]),
    ...outermostPackageDirectories,
  ]);
  const entriesByDirectory = Map.groupBy([...paths, ...directories], directoryOf);
  return [...directories].flatMap((directory) => {
    const [only, ...others] = entriesByDirectory.get(directory) ?? [];
    const holdsOnlyADirectory =
      only !== undefined &&
      others.length === 0 &&
      directories.has(only) &&
      !isLibraryDirectoryOfAModule(directory);
    return holdsOnlyADirectory
      ? [new DirectoryHoldsOnlyADirectory({ location: directory, child: fileNameOf(only) })]
      : [];
  });
};

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/u;

const moduleNameOf = (path: string) => fileNameOf(path).replace(SCRIPT_EXTENSION, "");

export const duplicateFileNameViolations = (paths: readonly string[]) => {
  const moduleDirectories = moduleDirectoriesAmong(paths);
  const nameScopeOf = (path: string) =>
    enclosingDirectoriesOf(path)
      .toReversed()
      .find(
        (directory) =>
          moduleDirectories.has(directory) ||
          directory === TEST_DIRECTORY ||
          directory === SCRIPTS_DIRECTORY,
      ) ?? PACKAGE_ROOT_SCOPE;
  const sources = paths.filter((path) => isScript(path) && !isEntryFileName(fileNameOf(path)));
  const sourcesByScopedName = Map.groupBy(
    sources,
    (path) => `${nameScopeOf(path)}/${moduleNameOf(path)}`,
  );
  return [...sourcesByScopedName.values()].flatMap((sameNamed) =>
    sameNamed.length === 1
      ? []
      : sameNamed.map(
          (path) =>
            new DuplicateFileName({
              location: path,
              otherPaths: sameNamed.filter((other) => other !== path),
              scope: nameScopeOf(path),
            }),
        ),
  );
};

export const packageRootViolations = (paths: readonly string[]) =>
  paths
    .filter((path) => {
      const isMisplacedTool = toolFileOf(path) !== undefined && !toolFileIsPlaced(path);
      return isWithin(path, DOCS_DIRECTORY) && !isMarkdown(path) && !isMisplacedTool;
    })
    .map((path) => new MisplacedAtPackageRoot({ location: path, place: "docs-non-markdown" }));

export const directoryNameViolations = (paths: readonly string[]) =>
  distinctDirectoriesOf(paths).flatMap((directory) =>
    nameViolationsOf(directory, directoryNameWords(fileNameOf(directory))),
  );

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
] as const;
const LOCAL_PATH_PROTOCOL = /^(?:file|link):/u;
const BARE_LOCAL_PATH = /^(?:\.{1,2}(?:\/|$)|\/)/u;
const isJsonObject = Schema.is(JSON_OBJECT);

const localPathOf = (specifier: string) => {
  if (LOCAL_PATH_PROTOCOL.test(specifier)) {
    return specifier.replace(LOCAL_PATH_PROTOCOL, "");
  }
  return BARE_LOCAL_PATH.test(specifier) ? specifier : undefined;
};

const specifiersIn = (
  field: string,
  value: Schema.Json | undefined,
): { field: string; specifier: string }[] => {
  if (typeof value === "string") {
    return [{ field, specifier: value }];
  }
  if (!isJsonObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([name, nested]) =>
    specifiersIn(`${field}.${name}`, nested),
  );
};

const isOutsideDirectory = (pathModule: Path.Path, directory: string, target: string) => {
  const fromDirectory = pathModule.relative(directory, target);
  return (
    fromDirectory === ".." ||
    fromDirectory.startsWith("../") ||
    pathModule.isAbsolute(fromDirectory)
  );
};

export const dependenciesOutsideRepository = (
  path: string,
  manifest: typeof JSON_OBJECT.Type,
  repository: { readonly root: string; readonly packageDirectory: string },
) =>
  Effect.gen(function* () {
    const pathModule = yield* Path.Path;
    const manifestDirectory = pathModule.join(
      repository.packageDirectory,
      pathModule.dirname(path),
    );
    return DEPENDENCY_FIELDS.flatMap((field) => specifiersIn(field, manifest[field])).flatMap(
      ({ field, specifier }) => {
        const localPath = localPathOf(specifier);
        if (localPath === undefined) {
          return [];
        }
        return isOutsideDirectory(
          pathModule,
          repository.root,
          pathModule.resolve(manifestDirectory, localPath),
        )
          ? [new DependencyOutsideRepository({ location: path, field, specifier })]
          : [];
      },
    );
  });

export const manifestViolations = (
  path: string,
  text: string,
  repository: Parameters<typeof dependenciesOutsideRepository>[2],
) =>
  Effect.gen(function* () {
    const manifest = packageManifestObject(path, text);
    if (Result.isFailure(manifest)) {
      return [manifest.failure];
    }
    const scriptsViolations = Predicate.hasProperty(manifest.success, "scripts")
      ? [new PackageScriptsField({ location: path })]
      : [];
    return [
      ...scriptsViolations,
      ...(yield* dependenciesOutsideRepository(path, manifest.success, repository)),
      ...packageEntriesNotTypeScript(path, manifest.success),
      ...exportPathMismatches(path, manifest.success),
    ];
  });

const ROOT_README = "README.md";

export const permissionGrantViolations = (
  paths: readonly string[],
  grants: Effect.Success<ReturnType<typeof loadedLintConfigIn>>,
  nestedPackageDirectories: readonly string[] = [],
) => {
  const repositoryFiles = new Set(paths);
  const generated = generatedPathsOf(grants);
  const outermostPackageDirectories = outermostDirectoriesOf(nestedPackageDirectories);
  const repositoryDirectories = new Set([
    ...distinctDirectoriesOf([...paths, ...outermostPackageDirectories]),
    ...outermostPackageDirectories,
  ]);
  const ownedDirectories = new Set([
    ...distinctDirectoriesOf([
      ...paths.filter((file) => !generated.has(file)),
      ...outermostPackageDirectories,
    ]),
    ...outermostPackageDirectories,
  ]);
  const directoriesNeedingGrants = [...ownedDirectories].filter((directory) =>
    isRootDirectoryOutsideTheLayout(directory),
  );
  const violations: (
    | CannotImportTargetMissing
    | DirectoryGrantedPermissions
    | DirectoryGrantOnFile
    | GrantedPathMissing
    | RedundantGrant
    | UngrantedDirectory
    | UngrantedDocument
  )[] = [];
  const isGranted = (path: string, permission: (typeof PERMISSION_NAMES)[number]) =>
    grants.some((grant) => grant.path === path && grant.allow.includes(permission));
  for (const path of paths) {
    const isUngrantedDocument =
      isMarkdown(path) &&
      path !== ROOT_README &&
      !generated.has(path) &&
      !isGranted(path, FILE_TYPE);
    if (isUngrantedDocument) {
      violations.push(new UngrantedDocument({ location: path }));
    }
  }
  const holdsOnlyGrantedPatches = (directory: string) => {
    const held = paths.filter((path) => isWithin(path, directory));
    return held.length > 0 && held.every((path) => isGrantedPatchFile(path, grants));
  };
  for (const directory of directoriesNeedingGrants) {
    const isGrantedDirectory =
      isGranted(directory, DIRECTORY) ||
      isGranted(directory, PATCH) ||
      holdsOnlyGrantedPatches(directory);
    if (!isGrantedDirectory) {
      violations.push(new UngrantedDirectory({ location: directory }));
    }
  }
  const isRepositoryDirectory = (path: string) => repositoryDirectories.has(path);
  const exists = (path: string) => repositoryFiles.has(path) || isRepositoryDirectory(path);
  for (const grant of grants) {
    if (!exists(grant.path)) {
      violations.push(new GrantedPathMissing({ path: grant.path }));
    }
    const grantsDirectoryToFile =
      repositoryFiles.has(grant.path) && grant.allow.includes(DIRECTORY);
    if (grantsDirectoryToFile) {
      violations.push(new DirectoryGrantOnFile({ path: grant.path }));
    }
    const isDirectoryGrantedPermissions =
      isRepositoryDirectory(grant.path) &&
      (grant.allow.some((permission) => permission !== DIRECTORY && permission !== PATCH) ||
        grant.services.length > 0);
    if (isDirectoryGrantedPermissions) {
      violations.push(new DirectoryGrantedPermissions({ path: grant.path }));
    }
    const grantsFileTypeToRootReadme =
      grant.path === ROOT_README && grant.allow.includes(FILE_TYPE);
    if (grantsFileTypeToRootReadme) {
      violations.push(
        new RedundantGrant({
          path: grant.path,
          permission: FILE_TYPE,
          reason: "the root README.md needs no grant",
        }),
      );
    }
    for (const target of grant.cannotImport.filter((candidate) => !exists(candidate))) {
      violations.push(new CannotImportTargetMissing({ path: grant.path, target }));
    }
    for (const target of grant.cannotImport.filter((candidate) =>
      repeatsSourceNeverImportsScripts(grant.path, candidate),
    )) {
      violations.push(
        new RedundantGrant({
          path: grant.path,
          permission: cannotImportPermission(target),
          reason: `files in ${SOURCE_DIRECTORY}/ cannot import ${SCRIPTS_DIRECTORY}/`,
        }),
      );
    }
  }
  return violations;
};

export const patchGrantViolations = (
  manifest: typeof JSON_OBJECT.Type,
  grants: Effect.Success<ReturnType<typeof loadedLintConfigIn>>,
) => {
  const patchedDependencies = patchedDependenciesOf(manifest);
  if (Result.isFailure(patchedDependencies)) {
    return [
      new PatchedDependenciesMalformed({
        location: PACKAGE_MANIFEST_FILE,
        reason: patchedDependencies.failure.message,
      }),
    ];
  }
  const patches = Object.entries(patchedDependencies.success).map(([dependency, patchPath]) => ({
    dependency,
    patchPath: normalizedPath(patchPath),
  }));
  const patchPaths = new Set(patches.map(({ patchPath }) => patchPath));
  const patchGrants = grants.filter((grant) => grant.allow.includes(PATCH));
  const grantedPatchPaths = new Set(patchGrants.map((grant) => grant.path));
  return [
    ...patches.flatMap(({ dependency, patchPath }) => {
      const patchesCheckOrTask = [CHECK_PACKAGE, TASK_PACKAGE].some((name) => {
        const namesPackage = dependency === name;
        const namesVersion = dependency.startsWith(`${name}@`);
        return namesPackage || namesVersion;
      });
      const isGrantedPatch =
        grantedPatchPaths.has(patchPath) || grantedPatchPaths.has(directoryOf(patchPath));
      const patchIsAllowed = !patchesCheckOrTask && isGrantedPatch;
      if (patchIsAllowed) {
        return [];
      }
      const fields = { location: PACKAGE_MANIFEST_FILE, dependency, patchPath };
      return [patchesCheckOrTask ? new CheckOrTaskPatched(fields) : new PatchNotGranted(fields)];
    }),
    ...patchGrants
      .filter(
        (grant) =>
          !patchPaths.has(grant.path) &&
          ![...patchPaths].some((patchPath) => directoryOf(patchPath) === grant.path),
      )
      .map((grant) => new UnlistedPatchGranted({ path: grant.path })),
  ];
};

const repositoryOf = (directory: string) =>
  Effect.gen(function* () {
    const repositoryRoot = yield* Task.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory,
    }).pipe(
      Effect.provideService(References.MinimumLogLevel, "Warn"),
      Effect.catchTag("CommandFailed", (failure) =>
        Effect.fail(new RepositoryRootNotFound({ directory, reason: failure.message })),
      ),
    );
    const packageDirectory = yield* FileSystem.FileSystem.use((fileSystem) =>
      fileSystem.realPath(directory),
    );
    return { root: repositoryRoot.trim(), packageDirectory };
  });

export const findFileLayoutViolations = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const repository = yield* repositoryOf(directory);
    const { packageFiles: paths, nestedPackageDirectories } = yield* listedPackageFiles(
      directory,
      [],
    );
    const grants = yield* loadedLintConfigIn(directory).pipe(
      Effect.asSome,
      Effect.catchTag(
        "LintConfigRefused",
        () => GRANTS_OF_A_REFUSED_CONFIG_ARE_REPORTED_BY_THE_LINT_CONFIG_TASK,
      ),
    );
    const rootManifest = yield* rootManifestIn(directory, paths);
    const binaryFiles = listedBinaryFilesOf(rootManifest);
    const generated = Option.match(grants, {
      onNone: () => new Set<string>(),
      onSome: generatedPathsOf,
    });
    const ownedPaths = paths.filter((file) => !generated.has(file));
    const listedPatches = listedPatchesOf(rootManifest);
    const isNamedByBunPatch = (path: string) =>
      listedPatches.some(
        ({ dependency, patchPath }) =>
          patchPath === path && fileNameOf(path) === bunPatchFileNameOf(dependency),
      ) &&
      Option.match(grants, {
        onNone: () => false,
        onSome: (found) => isGrantedPatchFile(path, found),
      });
    const ownedDirectories = new Set(
      distinctDirectoriesOf([...ownedPaths, ...nestedPackageDirectories]),
    );
    const shapeExemptDirectories = Option.match(grants, {
      onNone: () => [],
      onSome: (found) => directoriesExemptFromShapeRules(ownedDirectories, found),
    });
    const isShapeChecked = ({ location }: { readonly location: string }) =>
      !shapeExemptDirectories.some((exempt) => isWithin(location, exempt));
    const grantViolations = Option.match(grants, {
      onNone: () => [],
      onSome: (found) => [
        ...permissionGrantViolations(
          [...new Set([...paths, ...generated])],
          found,
          nestedPackageDirectories,
        ),
        ...patchGrantViolations(rootManifest, found),
      ],
    });
    const fileViolations = yield* Effect.forEach(
      paths.filter((file) => !generated.has(file) || isPackageManifest(file)),
      (path) =>
        Effect.gen(function* () {
          const found = pathViolations(path, isNamedByBunPatch(path));
          const isScriptFile = isScript(path);
          const isNeitherScriptNorManifest = !isScriptFile && !isPackageManifest(path);
          if (isNeitherScriptNorManifest) {
            return found;
          }
          const text = yield* fileSystem.readFileString(pathModule.join(directory, path));
          const absoluteDirectory = yield* absolutePathOf(directory);
          const imports = isTaskLayoutFile(path)
            ? yield* taskImportsIn(
                pathModule.join(absoluteDirectory, path),
                text,
                absoluteDirectory,
              )
            : undefined;
          return [
            ...found,
            ...(isScriptFile
              ? sourceViolations(path, text, imports, binaryFiles.has(path))
              : yield* manifestViolations(path, text, repository)),
          ];
        }),
      { concurrency: "unbounded" },
    );
    const violations = [
      ...fileViolations.flat(),
      ...directoryNameViolations(ownedPaths),
      ...directoryShapeViolations(ownedPaths).filter((violation) => isShapeChecked(violation)),
      ...directoriesHoldingOnlyADirectory(
        [...new Set([...paths, ...generated])],
        nestedPackageDirectories,
      ).filter(
        (violation) => ownedDirectories.has(violation.location) && isShapeChecked(violation),
      ),
      ...packageRootViolations(ownedPaths),
      ...duplicateFileNameViolations(ownedPaths),
      ...grantViolations,
    ];
    if (violations.length > 0) {
      return yield* new FileLayoutViolations({ violations });
    }
  });
