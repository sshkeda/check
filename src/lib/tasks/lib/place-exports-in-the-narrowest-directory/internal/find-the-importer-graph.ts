import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { parseSync } from "oxc-parser";
import type { ImportNameKind } from "oxc-parser";

import { FORMAT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import {
  isDeclarationFile,
  isTopLevelScript,
  isRootSupportFile,
  isUnderTestDirectory,
  isScript,
  moduleDirectoriesAmong,
  packagePathOf,
} from "../../../shared/classify-files-by-role.ts";
import { lineNumbersIn, lineOfTheFirstLabel } from "../../../shared/count-the-line-of-an-offset.ts";
import { moduleRequestsIn, URL_REQUESTS } from "../../../shared/find-module-requests.ts";
import type { MODULE_REQUEST_KINDS } from "../../../shared/find-module-requests.ts";
import { existingPackageFiles } from "../../../shared/list-package-files.ts";
import { isFormatConfigTextRefusedIn } from "../../../shared/parse-config-files-that-import-from-check.ts";
import {
  BunConfigInvalid,
  SourceFileUnparsable,
} from "../../../shared/project-config-and-tool-errors.ts";
import type { ModuleRequestUnresolvable } from "../../../shared/project-config-and-tool-errors.ts";
import {
  checkedSourceFiles,
  CUSTOM_CONDITIONS,
  effectiveCompilerOptions,
} from "../../../shared/query-the-typescript-project.ts";
import { resolveModuleRequest } from "../../../shared/resolve-module-requests.ts";
import { ImportUnresolvableInTheImportBoundaryCheck } from "./export-placement-errors.ts";
import { packageEntrySourcesAmong } from "./find-package-entry-sources.ts";

export const EVERY_EXPORT = "*";
export const DEFAULT_EXPORT = "default";
const BUN_CONFIG_FILE = "bunfig.toml";
const PRELOADS = Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)]));
const BUN_CONFIG = Schema.Struct({
  preload: PRELOADS,
  test: Schema.optionalKey(Schema.Struct({ preload: PRELOADS })),
});
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
    Effect.Services<ReturnType<typeof resolveModuleRequest>>
  >,
) =>
  Effect.gen(function* () {
    const parsed = parseSync(path, text);
    if (parsed.errors.length > 0) {
      return yield* new SourceFileUnparsable({
        file: path,
        ...lineOfTheFirstLabel(
          text,
          parsed.errors.flatMap((error) => error.labels),
        ),
        reason: parsed.errors.map((error) => error.message).join("; "),
      });
    }
    const lineAt = lineNumbersIn(text);
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
          line: lineAt(declaration.start),
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
            line: lineAt(entry.start),
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
          line: lineAt(request.start),
          kind: request.kind,
        });
      }
    }
    return { uses, parsed, text };
  });

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
      yield* existingPackageFiles(packageDirectory, [BUN_CONFIG_FILE]),
    );
    const readTrackedFile = (name: string) =>
      trackedPackageFiles.has(name)
        ? fileSystem.readFileString(path.join(packageDirectory, name)).pipe(Effect.asSome)
        : Effect.succeedNone;
    const entrySources = yield* packageEntrySourcesAmong(packageDirectory, paths);
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
