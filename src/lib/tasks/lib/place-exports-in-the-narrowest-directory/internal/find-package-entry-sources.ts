import { Effect, FileSystem, Path, Schema } from "effect";

import { isTypeScriptSourceFile } from "../../../shared/classify-files-by-role.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { existingPackageFiles } from "../../../shared/list-package-files.ts";
import {
  PackageExportsMixKeys,
  PackageManifestFieldInvalid,
} from "../../../shared/project-config-and-tool-errors.ts";
import { JSON_OBJECT } from "../../../shared/read-package-manifest-object.ts";

const PACKAGE_PATTERN_WILDCARD = "*";
const PARTS_AROUND_ONE_WILDCARD = 2;

const PACKAGE_ENTRIES = Schema.fromJsonString(
  Schema.Struct({
    main: Schema.optionalKey(Schema.String),
    module: Schema.optionalKey(Schema.String),
    types: Schema.optionalKey(Schema.String),
    typings: Schema.optionalKey(Schema.String),
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
const capturingPattern = (entry: string) =>
  new RegExp(
    `^${entry
      .split(PACKAGE_PATTERN_WILDCARD)
      .map((part) => RegExp.escape(part))
      .join("(.+)")}$`,
    "u",
  );

const packageEntryMatch = (entry: string) => {
  const pattern = capturingPattern(entry);
  return (path: string) => (isTypeScriptSourceFile(path) ? pattern.exec(path) : null);
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

export const packageEntrySourcesAmong = (packageDirectory: string, paths: readonly string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestFile = path.join(packageDirectory, PACKAGE_MANIFEST_FILE);
    const listed = yield* existingPackageFiles(packageDirectory, [PACKAGE_MANIFEST_FILE]);
    const decodedManifest = (text: string) =>
      Schema.decodeEffect(PACKAGE_ENTRIES)(text).pipe(
        Effect.mapError(
          (error) => new PackageManifestFieldInvalid({ path: manifestFile, reason: error.message }),
        ),
      );
    const manifest = listed.includes(PACKAGE_MANIFEST_FILE)
      ? yield* fileSystem.readFileString(manifestFile).pipe(Effect.flatMap(decodedManifest))
      : {};
    const sourcesOfEntry = (entry: string) => {
      const matchOf = packageEntryMatch(path.normalize(entry).split(path.sep).join("/"));
      return paths.flatMap((file) => {
        const matched = matchOf(file);
        return matched === null ? [] : [{ file, capture: matched[1] }];
      });
    };
    const manifestEntries = [manifest.main, manifest.module, manifest.types, manifest.typings]
      .filter((entry) => entry !== undefined)
      .filter((entry) => isTypeScriptSourceFile(entry));
    const subpaths = manifest.exports === undefined ? [] : exportsSubpathEntries(manifest.exports);
    if (subpaths === undefined) {
      return yield* new PackageExportsMixKeys({ path: manifestFile });
    }
    const subpathKeys = subpaths.map(([subpath]) => subpath);
    return [
      ...manifestEntries.map((entry) => {
        const sources = sourcesOfEntry(entry).map(({ file }) => file);
        return { entry, sources, started: sources };
      }),
      ...subpaths.flatMap(([subpath, target]) =>
        stringsIn(target)
          .filter((entry) => isTypeScriptSourceFile(entry))
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
  });
