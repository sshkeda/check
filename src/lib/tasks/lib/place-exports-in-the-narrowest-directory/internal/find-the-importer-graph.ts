import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { parseSync } from "oxc-parser";
import type { ImportNameKind } from "oxc-parser";

import { FORMAT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import { isWithin } from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import {
  isDeclarationFile,
  isTopLevelScript,
  isRootSupportFile,
  isUnderTestDirectory,
  isScript,
  moduleDirectoriesAmong,
  packagePathOf,
} from "../../../shared/classify-files-by-role.ts";
import { lineNumberAt } from "../../../shared/count-the-line-of-an-offset.ts";
import { moduleRequestsIn, URL_REQUESTS } from "../../../shared/find-module-requests.ts";
import type { MODULE_REQUEST_KINDS } from "../../../shared/find-module-requests.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { existingPackageFiles } from "../../../shared/list-package-files.ts";
import { isFormatConfigTextRefusedIn } from "../../../shared/parse-config-files-that-import-from-check.ts";
import {
  BunConfigInvalid,
  PackageExportsMixKeys,
  PackageManifestFieldInvalid,
  SourceFileUnparsable,
} from "../../../shared/project-config-and-tool-errors.ts";
import type { ModuleRequestUnresolvable } from "../../../shared/project-config-and-tool-errors.ts";
import {
  checkedSourceFiles,
  CUSTOM_CONDITIONS,
  effectiveCompilerOptions,
} from "../../../shared/query-the-typescript-project.ts";
import { JSON_OBJECT } from "../../../shared/read-package-manifest-object.ts";
import { resolveModuleRequest } from "../../../shared/resolve-module-requests.ts";
import { ImportUnresolvableInTheImportBoundaryCheck } from "./export-placement-errors.ts";

export const EVERY_EXPORT = "*";
export const DEFAULT_EXPORT = "default";
const SOURCE_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/u;
const TYPESCRIPT_PROJECT_PATTERN = "tsconfig*.json";
const TYPESCRIPT_PROJECT_FILE_NAME = /^tsconfig(?:\.[\w-]+)?\.json$/u;
const BUILD_DIRECTORIES = Schema.Struct({
  outDir: Schema.optionalKey(Schema.String),
  rootDir: Schema.optionalKey(Schema.String),
});
const BUN_CONFIG_FILE = "bunfig.toml";
const PRELOADS = Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)]));
const BUN_CONFIG = Schema.Struct({
  preload: PRELOADS,
  test: Schema.optionalKey(Schema.Struct({ preload: PRELOADS })),
});
const PACKAGE_PATTERN_WILDCARD = "*";
const PARTS_AROUND_ONE_WILDCARD = 2;

const PACKAGE_ENTRIES = Schema.fromJsonString(
  Schema.Struct({
    main: Schema.optionalKey(Schema.String),
    module: Schema.optionalKey(Schema.String),
    exports: Schema.optionalKey(Schema.Json),
  }),
);

const stringsIn = (value: Schema.Json): readonly string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: Schema.Json) => stringsIn(item));
  }
  return Schema.is(JSON_OBJECT)(value)
    ? Object.values(value).flatMap((item) => stringsIn(item))
    : [];
};

const importedNameOf = (importName: {
  readonly kind: `${ImportNameKind}`;
  readonly name: string | null;
}) => {
  if (importName.kind === "Default") {
    return DEFAULT_EXPORT;
  }
  return importName.kind === "Name" ? (importName.name ?? DEFAULT_EXPORT) : EVERY_EXPORT;
};

const CURRENT_DIRECTORY_PREFIX = /^\.\//u;

const fromPackageRoot = (importer: string, specifier: string) =>
  specifier.startsWith("/")
    ? specifier
    : `${"../".repeat(importer.split("/").length - 1) || "./"}${specifier.replace(CURRENT_DIRECTORY_PREFIX, "")}`;

const failedAlsoInTheImportBoundaryCheck = Effect.mapError(
  (failure: ModuleRequestUnresolvable) =>
    new ImportUnresolvableInTheImportBoundaryCheck({
      request: failure.request,
      importingFile: failure.importingFile,
    }),
);

const moduleUsesIn = (
  path: string,
  text: string,
  resolve: (
    specifier: string,
  ) => Effect.Effect<
    string | undefined,
    ModuleRequestUnresolvable,
    FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const parsed = parseSync(path, text);
    if (parsed.errors.length > 0) {
      return yield* new SourceFileUnparsable({
        file: path,
        reason: parsed.errors.map((error) => error.message).join("; "),
      });
    }
    const uses: {
      readonly file: string;
      readonly names: readonly string[];
      readonly line: number;
      readonly kind: (typeof MODULE_REQUEST_KINDS)[number];
    }[] = [];
    for (const declaration of parsed.module.staticImports) {
      const file = yield* resolve(declaration.moduleRequest.value).pipe(
        failedAlsoInTheImportBoundaryCheck,
      );
      const importsOnlyTypes =
        declaration.entries.length > 0 && declaration.entries.every((entry) => entry.isType);
      if (file !== undefined) {
        uses.push({
          file,
          names: declaration.entries.map((entry) => importedNameOf(entry.importName)),
          line: lineNumberAt(text, declaration.start),
          kind: importsOnlyTypes ? "type" : "static",
        });
      }
    }
    for (const declaration of parsed.module.staticExports) {
      for (const entry of declaration.entries) {
        const file =
          entry.moduleRequest === null
            ? undefined
            : yield* resolve(entry.moduleRequest.value).pipe(failedAlsoInTheImportBoundaryCheck);
        if (file !== undefined) {
          uses.push({
            file,
            names: [
              entry.importName.kind === "Name"
                ? (entry.importName.name ?? DEFAULT_EXPORT)
                : EVERY_EXPORT,
            ],
            line: lineNumberAt(text, entry.start),
            kind: entry.isType ? "type" : "static",
          });
        }
      }
    }
    const { requests } = moduleRequestsIn(parsed);
    for (const request of requests) {
      if (request.kind === "static") {
        continue;
      }
      const isSkippedByTheImportBoundaryCheck =
        request.kind === "build" ||
        (URL_REQUESTS.has(request.kind) && !isScript(request.specifier));
      const file = isSkippedByTheImportBoundaryCheck
        ? yield* resolve(
            request.kind === "build" ? fromPackageRoot(path, request.specifier) : request.specifier,
          )
        : yield* resolve(request.specifier).pipe(failedAlsoInTheImportBoundaryCheck);
      if (file !== undefined) {
        uses.push({
          file,
          names: request.kind === "launch" ? [] : [request.namedExport ?? EVERY_EXPORT],
          line: lineNumberAt(text, request.start),
          kind: request.kind,
        });
      }
    }
    return { uses, parsed, text };
  });

const withoutExtension = (path: string) => path.replace(SOURCE_EXTENSION, "");

const capturingPattern = (entry: string) =>
  new RegExp(
    `^${withoutExtension(entry)
      .split(PACKAGE_PATTERN_WILDCARD)
      .map((part) => RegExp.escape(part))
      .join("(.+)")}$`,
    "u",
  );

const packageEntryMatches = (entries: readonly string[]) => {
  const patterns = entries.map((entry) => capturingPattern(entry));
  return (path: string) =>
    SOURCE_EXTENSION.test(path)
      ? patterns.flatMap((pattern) => {
          const matched = pattern.exec(withoutExtension(path));
          return matched === null ? [] : [{ capture: matched[1] }];
        })
      : [];
};

const exportsSubpathEntries = (exportsField: Schema.Json) => {
  const isSingleExportTarget =
    exportsField === null || typeof exportsField !== "object" || Array.isArray(exportsField);
  if (isSingleExportTarget) {
    return [[".", exportsField] as const];
  }
  const keys = Object.keys(exportsField);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return [[".", exportsField] as const];
  }
  return subpathKeys.length === keys.length ? Object.entries(exportsField) : undefined;
};

const subpathMatcher = (subpathPattern: string) =>
  new RegExp(
    `^${subpathPattern
      .split(PACKAGE_PATTERN_WILDCARD)
      .map((part) => RegExp.escape(part))
      .join(".+")}$`,
    "u",
  );

const patternPrefixLength = (key: string) => key.indexOf(PACKAGE_PATTERN_WILDCARD);

const isSubpathPattern = (key: string) =>
  key.split(PACKAGE_PATTERN_WILDCARD).length === PARTS_AROUND_ONE_WILDCARD;

const subpathKeyFor = (keys: readonly string[], subpath: string) => {
  if (keys.includes(subpath)) {
    return subpath;
  }
  return keys
    .filter((key) => isSubpathPattern(key) && subpathMatcher(key).test(subpath))
    .toSorted(
      (first, second) =>
        patternPrefixLength(second) - patternPrefixLength(first) || second.length - first.length,
    )[0];
};

export const findTheImporterGraph = (projectFile: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDirectory = yield* fileSystem.realPath(path.dirname(projectFile));
    const { customConditions = [] } = yield* Schema.decodeEffect(CUSTOM_CONDITIONS)(
      yield* effectiveCompilerOptions(projectFile),
    );
    const isFormatConfigRefused = yield* isFormatConfigTextRefusedIn(packageDirectory);
    const paths = (yield* checkedSourceFiles(projectFile)).filter(
      (file) => !isFormatConfigRefused || file !== FORMAT_CONFIG_FILE,
    );
    const known = new Set(paths);
    const knownPackagePathOf = (file: string) => {
      const relative = packagePathOf(path, packageDirectory, file);
      return known.has(relative) ? relative : undefined;
    };
    const resolverFor = (importer: string) => (specifier: string) =>
      resolveModuleRequest({
        request: specifier,
        importingFile: path.join(packageDirectory, importer),
        customConditions,
        projectDirectory: packageDirectory,
      }).pipe(
        Effect.map((resolved) =>
          resolved === undefined ? undefined : knownPackagePathOf(resolved.file),
        ),
      );
    const files = new Map<string, Effect.Success<ReturnType<typeof moduleUsesIn>>>();
    for (const file of paths) {
      const text = yield* fileSystem.readFileString(path.join(packageDirectory, file));
      files.set(file, yield* moduleUsesIn(file, text, resolverFor(file)));
    }

    const trackedPackageFiles = new Set(
      yield* existingPackageFiles(packageDirectory, [
        PACKAGE_MANIFEST_FILE,
        BUN_CONFIG_FILE,
        TYPESCRIPT_PROJECT_PATTERN,
      ]),
    );
    const readTrackedFile = (name: string) =>
      trackedPackageFiles.has(name)
        ? fileSystem.readFileString(path.join(packageDirectory, name)).pipe(Effect.asSome)
        : Effect.succeedNone;
    const manifestText = yield* readTrackedFile(PACKAGE_MANIFEST_FILE);
    const manifest = Option.isNone(manifestText)
      ? {}
      : yield* Schema.decodeEffect(PACKAGE_ENTRIES)(manifestText.value).pipe(
          Effect.mapError(
            (error) =>
              new PackageManifestFieldInvalid({
                path: path.join(packageDirectory, PACKAGE_MANIFEST_FILE),
                reason: error.message,
              }),
          ),
        );
    const buildDirectories = yield* Effect.forEach(
      [...trackedPackageFiles].filter((name) => TYPESCRIPT_PROJECT_FILE_NAME.test(name)),
      (name) =>
        effectiveCompilerOptions(path.join(packageDirectory, name)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(BUILD_DIRECTORIES)),
          Effect.map((options) =>
            options.outDir === undefined
              ? []
              : [{ outDirectory: options.outDir, rootDirectory: options.rootDir ?? "" }],
          ),
        ),
    );
    const sourcesOfEntry = (entry: string) => {
      const normalized = path.normalize(entry).split(path.sep).join("/");
      const mapped = buildDirectories
        .flat()
        .flatMap(({ outDirectory, rootDirectory }) =>
          isWithin(normalized, outDirectory)
            ? [
                path
                  .join(rootDirectory, path.relative(outDirectory, normalized))
                  .split(path.sep)
                  .join("/"),
              ]
            : [],
        );
      const matchesOf = packageEntryMatches([normalized, ...mapped]);
      return paths.flatMap((file) =>
        matchesOf(file)
          .slice(0, 1)
          .map(({ capture }) => ({ file, capture })),
      );
    };
    const manifestEntries = [manifest.main, manifest.module]
      .filter((entry) => entry !== undefined)
      .filter((entry) => SOURCE_EXTENSION.test(entry));
    const subpaths = manifest.exports === undefined ? [] : exportsSubpathEntries(manifest.exports);
    if (subpaths === undefined) {
      return yield* new PackageExportsMixKeys({
        path: path.join(packageDirectory, PACKAGE_MANIFEST_FILE),
      });
    }
    const subpathKeys = subpaths.map(([subpath]) => subpath);
    const entrySources = [
      ...manifestEntries.map((entry) => {
        const sources = sourcesOfEntry(entry).map(({ file }) => file);
        return { entry, sources, started: sources };
      }),
      ...subpaths.flatMap(([subpath, target]) =>
        stringsIn(target)
          .filter((entry) => SOURCE_EXTENSION.test(entry))
          .map((entry) => {
            const matched = sourcesOfEntry(entry);
            return {
              entry,
              sources: matched.map(({ file }) => file),
              started: matched
                .filter(({ capture }) => {
                  const exposed =
                    capture === undefined
                      ? subpath
                      : subpath.replace(PACKAGE_PATTERN_WILDCARD, capture);
                  return subpathKeyFor(subpathKeys, exposed) === subpath;
                })
                .map(({ file }) => file),
            };
          }),
      ),
    ];
    const bunConfig = yield* readTrackedFile(BUN_CONFIG_FILE);
    const bunConfigPath = path.join(packageDirectory, BUN_CONFIG_FILE);
    const bunOptions = Option.isNone(bunConfig)
      ? {}
      : yield* Effect.try({
          try: () => Bun.TOML.parse(bunConfig.value),
          catch: (error) => new BunConfigInvalid({ path: bunConfigPath, reason: String(error) }),
        }).pipe(
          Effect.flatMap((parsed) =>
            Schema.decodeEffect(BUN_CONFIG)(parsed).pipe(
              Effect.mapError(
                (error) => new BunConfigInvalid({ path: bunConfigPath, reason: error.message }),
              ),
            ),
          ),
        );
    const preloadedBy = (preloads: (typeof BUN_CONFIG.Type)["preload"]) =>
      (preloads === undefined ? [] : [preloads].flat()).flatMap((preload) => {
        const loaded = knownPackagePathOf(path.join(packageDirectory, preload));
        return loaded === undefined ? [] : [loaded];
      });
    const preloaded = preloadedBy(bunOptions.preload);
    const testPreloaded = preloadedBy(bunOptions.test?.preload);

    const reach = (
      seeds: Iterable<string>,
      isFollowed: (
        use: Effect.Success<ReturnType<typeof moduleUsesIn>>["uses"][number],
      ) => boolean = () => true,
    ) => {
      const reached = new Set<string>();
      const pending = [...seeds];
      for (const next of pending) {
        const parsed = files.get(next);
        const isUnreachedParsedFile = !reached.has(next) && parsed !== undefined;
        if (!isUnreachedParsedFile) {
          continue;
        }
        reached.add(next);
        pending.push(...parsed.uses.filter(isFollowed).map((use) => use.file));
      }
      return reached;
    };
    const packageEntries = new Set(entrySources.flatMap(({ started }) => started));
    const exportsAreReadFromOutside = (file: string) =>
      packageEntries.has(file) || isTopLevelScript(file) || isRootSupportFile(file);
    const roots = new Set([
      ...paths.filter((file) => exportsAreReadFromOutside(file)),
      ...preloaded,
      ...testPreloaded,
    ]);
    const reachable = reach([
      ...roots,
      ...[...files.keys()].filter((file) => isDeclarationFile(file) || isUnderTestDirectory(file)),
    ]);
    const importers = new Map<string, Set<string>>();
    for (const [importer, parsed] of files) {
      const isCountedImporter = reachable.has(importer) && !isUnderTestDirectory(importer);
      for (const use of isCountedImporter ? parsed.uses : []) {
        if (use.file !== importer) {
          importers.set(use.file, (importers.get(use.file) ?? new Set()).add(importer));
        }
      }
    }
    const importersOf = (file: string) => [...(importers.get(file) ?? [])];
    const moduleDirectories = moduleDirectoriesAmong(paths);
    return {
      paths,
      files,
      entrySources,
      reach,
      exportsAreReadFromOutside,
      roots,
      reachable,
      moduleDirectories,
      importersOf,
    };
  });
