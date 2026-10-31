import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { isFileSpecifier } from "../../../shared/classify-files-by-role.ts";
import { conditionNamesWith } from "../../../shared/create-the-module-resolver.ts";
import { enclosingPackageManifestsOf } from "../../../shared/find-named-package-manifests.ts";
import { ModuleRequestUnresolvable } from "../../../shared/project-config-and-tool-errors.ts";
import {
  JSON_OBJECT,
  packageManifestObject,
} from "../../../shared/read-package-manifest-object.ts";

const SUBPATH_IMPORT_PREFIX = "#";
const PATTERN_WILDCARD = "*";
const DEFAULT_CONDITION = "default";
const isJsonObject = Schema.is(JSON_OBJECT);

const conditionalTarget = (
  value: Schema.Json,
  conditionNames: ReadonlySet<string>,
): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item: Schema.Json) => conditionalTarget(item, conditionNames))
      .find((target) => target !== undefined);
  }
  if (!isJsonObject(value)) {
    return;
  }
  const matched = Object.entries(value).find(
    ([condition]) => condition === DEFAULT_CONDITION || conditionNames.has(condition),
  );
  return matched === undefined ? undefined : conditionalTarget(matched[1], conditionNames);
};

const matchedImport = (imports: typeof JSON_OBJECT.Type, request: string) => {
  const exact = imports[request];
  const isExactKey = exact !== undefined && !request.includes(PATTERN_WILDCARD);
  if (isExactKey) {
    return { value: exact, capture: "" };
  }
  const [longest] = Object.keys(imports)
    .flatMap((key) => {
      const [prefix = "", suffix, ...more] = key.split(PATTERN_WILDCARD);
      const matchesPattern =
        suffix !== undefined &&
        more.length === 0 &&
        request.length >= key.length &&
        request.startsWith(prefix) &&
        request.endsWith(suffix);
      return matchesPattern
        ? [{ key, prefix, capture: request.slice(prefix.length, request.length - suffix.length) }]
        : [];
    })
    .toSorted(
      (first, second) =>
        second.prefix.length - first.prefix.length || second.key.length - first.key.length,
    );
  if (longest === undefined) {
    return;
  }
  const value = imports[longest.key];
  return value === undefined ? undefined : { value, capture: longest.capture };
};

const nearestManifestImports = (directory: string, projectDirectory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const manifestFile of enclosingPackageManifestsOf(directory, projectDirectory)) {
      if (yield* fileSystem.exists(manifestFile)) {
        const manifest = yield* Effect.fromResult(
          packageManifestObject(manifestFile, yield* fileSystem.readFileString(manifestFile)),
        );
        const { imports } = manifest;
        return isJsonObject(imports) ? Option.some(imports) : Option.none();
      }
    }
    return Option.none<typeof JSON_OBJECT.Type>();
  });

export const packageRequestBehindSubpathImport = ({
  request,
  importingFile,
  customConditions,
  projectDirectory,
}: {
  readonly request: string;
  readonly importingFile: string;
  readonly customConditions: readonly string[];
  readonly projectDirectory: string;
}) =>
  Effect.gen(function* () {
    if (!request.startsWith(SUBPATH_IMPORT_PREFIX)) {
      return;
    }
    const path = yield* Path.Path;
    const imports = yield* nearestManifestImports(path.dirname(importingFile), projectDirectory);
    if (Option.isNone(imports)) {
      return;
    }
    const matched = matchedImport(imports.value, request);
    if (matched === undefined) {
      return;
    }
    const target = conditionalTarget(matched.value, new Set(conditionNamesWith(customConditions)));
    if (target === undefined) {
      return;
    }
    const packageRequest = target.replaceAll(PATTERN_WILDCARD, matched.capture);
    return isFileSpecifier(packageRequest) ? undefined : packageRequest;
  }).pipe(
    Effect.mapError(
      (error) => new ModuleRequestUnresolvable({ request, importingFile, reason: error.message }),
    ),
  );
