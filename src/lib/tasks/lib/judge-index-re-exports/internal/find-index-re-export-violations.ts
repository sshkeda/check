import { isBuiltin } from "node:module";

import { Effect, FileSystem, Option, Path, Result } from "effect";
import { parseSync } from "oxc-parser";
import type { ResolveResult } from "oxc-resolver";

import { nodeBuiltinNameOf } from "../../../../../shared/lint-rule-messages-and-patterns.ts";
import {
  directoryHolding,
  fileNameOf,
  INTERNAL_DIRECTORY_NAME,
  isEntryFileName,
  isWithin,
  LAYOUT_DIRECTORY_NAMES,
  SHARED_DIRECTORY_NAME,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import { lineNumbersIn } from "../../../shared/count-the-line-of-an-offset.ts";
import { moduleResolverFor } from "../../../shared/create-the-module-resolver.ts";
import {
  directoriesAFailedResolutionReads,
  enclosingPackageManifestsOf,
  resolutionNamesNoFile,
} from "../../../shared/find-named-package-manifests.ts";
import { ownedFilesAmong } from "../../../shared/list-owned-files.ts";
import { ModuleRequestUnresolvable } from "../../../shared/project-config-and-tool-errors.ts";
import type { PackageManifestUnreadable } from "../../../shared/project-config-and-tool-errors.ts";
import { checkedSourceFiles } from "../../../shared/query-the-typescript-project.ts";
import { namedPackageManifestAt } from "../../../shared/read-named-package-manifests.ts";
import { IndexReExportRefused, IndexReExportsRefused } from "./index-re-export-errors.ts";

const OWN_LAYOUT_DIRECTORIES = `${INTERNAL_DIRECTORY_NAME}/ and ${SHARED_DIRECTORY_NAME}/`;
const RE_EXPORTABLE_EXTENSIONS = ".ts or .tsx";
const RE_EXPORTABLE_FILE = /^.+\.tsx?$/u;
const INDEX_FILE = /^index(?:\.d)?\.tsx?$/u;
const NAMESPACE_INDEX = /^\.\/lib\/[^/.][^/]*\/index\.tsx?$/u;
const INSTALLED_PACKAGES_DIRECTORY = "node_modules";
const FILE_SYSTEM_ROOT = "/";
const GIT_DIRECTORY_NAME = ".git";
const DECLARATION_FILE_EXTENSION = ".d.ts";
const BUN_BUILT_IN_MODULES: ReadonlySet<string> = new Set([
  "bun",
  "bun:ffi",
  "bun:jsc",
  "bun:sqlite",
  "bun:test",
]);

const isBuiltInModule = (specifier: string) =>
  isBuiltin(nodeBuiltinNameOf(specifier)) || BUN_BUILT_IN_MODULES.has(specifier);

const FACTS = {
  fromPackage: () => "re-exports a package or built-in",
  fromOutsideLayout: () => `re-exports a file outside this index's own ${OWN_LAYOUT_DIRECTORIES}`,
  fromLayoutSubdirectory: (directory: string) =>
    `re-exports a file in a subdirectory of ${directory}/`,
  fromOtherExtension: () => `re-exports a file without a ${RE_EXPORTABLE_EXTENSIONS} extension`,
  fromLayoutIndex: () => "re-exports an index file",
  fromDeclarationFile: () => "re-exports a declaration file",
  badManifest: (manifest: string, reason: string) =>
    `cannot be judged, since ${manifest} cannot be read as a package.json: ${reason}`,
  unresolvable: (reason: string) => `cannot be judged, since the resolver failed: ${reason}`,
} as const;

const relativePathFrom = (directory: string, file: string) => {
  const directorySegments = directory.split("/");
  const fileSegments = file.split("/");
  const differingSegment = directorySegments.findIndex(
    (segment, at) => segment !== fileSegments[at],
  );
  const firstOwnSegment = differingSegment === -1 ? directorySegments.length : differingSegment;
  const parents = directorySegments.slice(firstOwnSegment).map(() => "..");
  const start = parents.length === 0 ? "." : parents.join("/");
  return [start, ...fileSegments.slice(firstOwnSegment)].join("/");
};

const repositoryRootHolding = Effect.fn("repositoryRootHolding")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const manifestFile of enclosingPackageManifestsOf(directory, FILE_SYSTEM_ROOT)) {
    const enclosing = directoryHolding(manifestFile);
    const holdsGit = yield* fileSystem.exists(`${enclosing}/${GIT_DIRECTORY_NAME}`);
    if (holdsGit) {
      return enclosing;
    }
  }
  return FILE_SYSTEM_ROOT;
});

const namedPackageEnclosing = Effect.fn("namedPackageEnclosing")(function* (directory: string) {
  for (const manifestFile of enclosingPackageManifestsOf(
    directory,
    yield* repositoryRootHolding(directory),
  )) {
    const named = yield* namedPackageManifestAt(manifestFile);
    if (Option.isSome(named)) {
      return Option.some(manifestFile);
    }
  }
  return Option.none<string>();
});

const namedPackageOrItsFailure = (directory: string) =>
  namedPackageEnclosing(directory).pipe(
    Effect.map((named) => Result.succeed<Option.Option<string>>(named)),
    Effect.catchTag("PackageManifestUnreadable", (failure) =>
      Effect.succeed(Result.fail<PackageManifestUnreadable>(failure)),
    ),
  );

const realIndexOf = Effect.fn("realIndexOf")(function* (indexFile: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* fileSystem.realPath(indexFile);
  const directory = directoryHolding(file);
  return { file, directory, namedPackage: yield* namedPackageOrItsFailure(directory) };
});

const badManifestOf = (directory: string, failure: PackageManifestUnreadable) =>
  ({
    judgment: FACTS.badManifest(relativePathFrom(directory, failure.location), failure.reason),
  }) as const;

const resolvedRequest = (importingFile: string, request: string) =>
  moduleResolverFor([]).pipe(
    Effect.flatMap((resolver) =>
      Effect.tryPromise({
        try: () => resolver.resolveFileAsync(importingFile, request),
        catch: (cause) =>
          new ModuleRequestUnresolvable({ request, importingFile, reason: String(cause) }),
      }),
    ),
  );

const unresolvedFactOf = Effect.fn("unresolvedFactOf")(function* (
  index: Effect.Success<ReturnType<typeof realIndexOf>>,
  request: string,
  resolved: ResolveResult,
) {
  for (const directory of directoriesAFailedResolutionReads({
    importingFile: index.file,
    request,
  })) {
    const named = yield* namedPackageOrItsFailure(directory);
    if (Result.isFailure(named)) {
      return badManifestOf(index.directory, named.failure);
    }
  }
  const reason = resolved.error ?? "returned no file and no error";
  return resolutionNamesNoFile(resolved, reason)
    ? undefined
    : ({ judgment: FACTS.unresolvable(reason) } as const);
});

const resolvedFactOf = Effect.fn("resolvedFactOf")(function* (
  index: Effect.Success<ReturnType<typeof realIndexOf>>,
  source: string,
) {
  if (isBuiltInModule(source)) {
    return { judgment: FACTS.fromPackage() } as const;
  }
  const resolved = yield* resolvedRequest(index.file, source);
  const file = resolved.path;
  if (file === undefined) {
    return yield* unresolvedFactOf(index, source, resolved);
  }
  if (Result.isFailure(index.namedPackage)) {
    return badManifestOf(index.directory, index.namedPackage.failure);
  }
  const filePackage = yield* namedPackageOrItsFailure(directoryHolding(file));
  if (Result.isFailure(filePackage)) {
    return badManifestOf(index.directory, filePackage.failure);
  }
  const indexSegments = index.directory.split("/");
  const fileSegments = file.split("/");
  const firstOwnSegment = fileSegments.findIndex((segment, at) => segment !== indexSegments[at]);
  const isFromAPackage =
    fileSegments.slice(firstOwnSegment).includes(INSTALLED_PACKAGES_DIRECTORY) ||
    Option.getOrNull(filePackage.success) !== Option.getOrNull(index.namedPackage.success);
  if (isFromAPackage) {
    return { judgment: FACTS.fromPackage() } as const;
  }
  const [layoutDirectory, fileName, ...deeper] = isWithin(file, index.directory)
    ? fileSegments.slice(indexSegments.length)
    : [];
  const isInOwnLayoutDirectory =
    layoutDirectory !== undefined &&
    LAYOUT_DIRECTORY_NAMES.has(layoutDirectory) &&
    fileName !== undefined;
  if (!isInOwnLayoutDirectory) {
    return { judgment: FACTS.fromOutsideLayout() } as const;
  }
  if (deeper.length > 0) {
    return { judgment: FACTS.fromLayoutSubdirectory(layoutDirectory) } as const;
  }
  if (INDEX_FILE.test(fileName)) {
    return { judgment: FACTS.fromLayoutIndex() } as const;
  }
  if (fileName.endsWith(DECLARATION_FILE_EXTENSION)) {
    return { judgment: FACTS.fromDeclarationFile() } as const;
  }
  return RE_EXPORTABLE_FILE.test(fileName)
    ? ({ allowed: true } as const)
    : ({ judgment: FACTS.fromOtherExtension() } as const);
});

const exportedName = (name: {
  readonly type: string;
  readonly name?: string;
  readonly value?: string;
}) => name.name ?? name.value;

const exportsOwnInternalNames = Effect.fn("exportsOwnInternalNames")(function* (
  index: Effect.Success<ReturnType<typeof realIndexOf>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const parsed = parseSync(index.file, yield* fileSystem.readFileString(index.file));
  const hasStatements = parsed.errors.length === 0 && parsed.program.body.length > 0;
  if (!hasStatements) {
    return false;
  }
  for (const statement of parsed.program.body) {
    if (statement.type !== "ExportNamedDeclaration") {
      return false;
    }
    const { source } = statement;
    const isDirectReExport = source !== null && statement.declaration === null;
    if (!isDirectReExport) {
      return false;
    }
    const fact = yield* resolvedFactOf(index, source.value);
    const resolved = (yield* resolvedRequest(index.file, source.value)).path;
    const ownInternalDirectory = `${index.directory}/${INTERNAL_DIRECTORY_NAME}`;
    const isInOwnInternalDirectory =
      resolved !== undefined &&
      directoryHolding(yield* fileSystem.realPath(resolved)) === ownInternalDirectory;
    const exportsUnrenamedNames =
      statement.specifiers.length > 0 &&
      statement.specifiers.every(
        (specifier) => exportedName(specifier.local) === exportedName(specifier.exported),
      );
    const isOwnInternalReExport =
      fact !== undefined && "allowed" in fact && exportsUnrenamedNames && isInOwnInternalDirectory;
    if (!isOwnInternalReExport) {
      return false;
    }
  }
  return true;
});

const exportsChildModuleNamespace = Effect.fn("exportsChildModuleNamespace")(function* (
  index: Effect.Success<ReturnType<typeof realIndexOf>>,
  source: string,
) {
  if (!NAMESPACE_INDEX.test(source)) {
    return false;
  }
  const resolved = (yield* resolvedRequest(index.file, source)).path;
  if (resolved === undefined) {
    return false;
  }
  const child = yield* realIndexOf(resolved);
  const isOwnChildIndex = child.file === `${index.directory}/${source.slice("./".length)}`;
  const isSamePackage =
    Result.isSuccess(index.namedPackage) &&
    Result.isSuccess(child.namedPackage) &&
    Option.getOrNull(index.namedPackage.success) === Option.getOrNull(child.namedPackage.success);
  const isOwnChildModule = isOwnChildIndex && isSamePackage;
  return isOwnChildModule && (yield* exportsOwnInternalNames(child));
});

export const indexReExportJudgmentsOf = Effect.fn("indexReExportJudgmentsOf")(function* (
  indexFile: string,
  text: string,
) {
  (yield* moduleResolverFor([])).clearCache();
  const { program } = parseSync(indexFile, text);
  const judgments: { readonly start: number; readonly judgment: string }[] = [];
  const exportsFromAModule = program.body.some(
    (statement) =>
      (statement.type === "ExportNamedDeclaration" && statement.source !== null) ||
      (statement.type === "ExportAllDeclaration" && statement.exported !== null),
  );
  if (!exportsFromAModule) {
    return judgments;
  }
  const index = yield* realIndexOf(indexFile);
  for (const statement of program.body) {
    if (statement.type === "ExportAllDeclaration") {
      const namespace = statement.exported;
      const namespaceSource = statement.source.value;
      const isChildModuleNamespace =
        namespace === null || (yield* exportsChildModuleNamespace(index, namespaceSource));
      if (!isChildModuleNamespace) {
        judgments.push({
          start: statement.start,
          judgment: `export * as ${text.slice(namespace.start, namespace.end)} from ${namespaceSource} re-exports another module`,
        });
      }
      continue;
    }
    const isExportFrom = statement.type === "ExportNamedDeclaration" && statement.source !== null;
    if (!isExportFrom) {
      continue;
    }
    const source = statement.source?.value ?? "";
    const fact = yield* resolvedFactOf(index, source);
    if (fact === undefined) {
      continue;
    }
    if ("judgment" in fact) {
      judgments.push({
        start: statement.start,
        judgment: `export from ${source} ${fact.judgment}`,
      });
      continue;
    }
    for (const specifier of statement.specifiers) {
      const local = exportedName(specifier.local);
      const exported = exportedName(specifier.exported);
      if (local !== exported) {
        judgments.push({
          start: specifier.start,
          judgment: `export from ${source} renames ${text.slice(specifier.local.start, specifier.local.end)} to ${text.slice(specifier.exported.start, specifier.exported.end)}`,
        });
      }
    }
  }
  return judgments;
});

export const findIndexReExportViolations = (projectFile: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDirectory = path.dirname(projectFile);
    const indexFiles = (yield* ownedFilesAmong(
      packageDirectory,
      yield* checkedSourceFiles(projectFile),
    )).filter((file) => isEntryFileName(fileNameOf(file)));
    const violations = yield* Effect.forEach(indexFiles, (displayName) =>
      Effect.gen(function* () {
        const text = yield* fileSystem.readFileString(path.join(packageDirectory, displayName));
        const judgments = yield* indexReExportJudgmentsOf(
          path.join(packageDirectory, displayName),
          text,
        );
        const lineAt = lineNumbersIn(text);
        return judgments.map(
          ({ start, judgment }) =>
            new IndexReExportRefused({
              location: `${displayName}:${lineAt(start)}`,
              judgment,
            }),
        );
      }),
    );
    const found = violations.flat();
    if (found.length > 0) {
      return yield* new IndexReExportsRefused({ violations: found });
    }
  });
