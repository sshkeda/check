import { Effect, FileSystem, Path, Result, Schema } from "effect";

import { normalizedPath, PATCH } from "../../../shared/record-and-grant-permissions-by-path.ts";
import type { PERMISSION_NAMES } from "../../../shared/record-and-grant-permissions-by-path.ts";
import { directoryOf } from "./classify-files-by-role.ts";
import { PACKAGE_MANIFEST_FILE } from "./find-named-package-manifests.ts";
import { packageManifestObject } from "./read-package-manifest-object.ts";
import type { JSON_OBJECT } from "./read-package-manifest-object.ts";

export const PATCHED_DEPENDENCIES_FIELD = "patchedDependencies";
const PATCHED_DEPENDENCIES = Schema.Record(Schema.String, Schema.String);
const PATCH_FILE_EXTENSION = ".patch";
const MANIFEST_FAILURES_ARE_REPORTED_BY_MANIFEST_VIOLATIONS = {} as const;

const BUN_PATCH_FILE_NAME_ESCAPES = new Map([
  ["/", "%2F"],
  ["\\", "%5c"],
  [" ", "%20"],
  ["\n", "%0A"],
  ["\r", "%0D"],
  ["\t", "%09"],
  [":", "%3A"],
  ["?", "%3F"],
  ["*", "%2A"],
  ['"', "%22"],
  ["<", "%3C"],
  [">", "%3E"],
  ["|", "%7C"],
]);
const BUN_PATCH_FILE_NAME_ESCAPED_CHARACTER = /[/\\ \n\r\t:?*"<>|]/gu;
const URL_AUTHORITY = /^(?<scheme>[^:]*:\/\/)(?<authority>[^/?#]*)(?<rest>[\s\S]*)$/u;

const withoutUrlCredentials = (key: string) => {
  const groups = URL_AUTHORITY.exec(key)?.groups;
  if (groups === undefined) {
    return key;
  }
  const { scheme = "", authority = "", rest = "" } = groups;
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const queryStart = rest.includes("?") ? rest.indexOf("?") : rest.length;
  const query = rest.slice(queryStart);
  const fragment = query.includes("#") ? query.slice(query.indexOf("#")) : "";
  return `${scheme}${host}${rest.slice(0, queryStart)}${fragment}`;
};

export const bunPatchFileNameOf = (dependency: string) =>
  `${withoutUrlCredentials(dependency)}${PATCH_FILE_EXTENSION}`.replaceAll(
    BUN_PATCH_FILE_NAME_ESCAPED_CHARACTER,
    (character) => BUN_PATCH_FILE_NAME_ESCAPES.get(character) ?? character,
  );

export const patchedDependenciesOf = (manifest: typeof JSON_OBJECT.Type) =>
  Schema.decodeUnknownResult(PATCHED_DEPENDENCIES)(manifest[PATCHED_DEPENDENCIES_FIELD] ?? {});

export const listedPatchesOf = (manifest: typeof JSON_OBJECT.Type) =>
  Object.entries(Result.getOrElse(patchedDependenciesOf(manifest), () => ({}))).map(
    ([dependency, patchPath]) => ({ dependency, patchPath: normalizedPath(patchPath) }),
  );

export const rootManifestIn = (directory: string, paths: readonly string[]) =>
  Effect.gen(function* () {
    if (!paths.includes(PACKAGE_MANIFEST_FILE)) {
      return {};
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const text = yield* fileSystem.readFileString(
      pathModule.join(directory, PACKAGE_MANIFEST_FILE),
    );
    return Result.getOrElse(
      packageManifestObject(PACKAGE_MANIFEST_FILE, text),
      () => MANIFEST_FAILURES_ARE_REPORTED_BY_MANIFEST_VIOLATIONS,
    );
  });

export const isGrantedPatchFile = (
  path: string,
  grants: readonly {
    readonly path: string;
    readonly allow?: readonly (typeof PERMISSION_NAMES)[number][];
  }[],
) =>
  path.endsWith(PATCH_FILE_EXTENSION) &&
  grants.some(
    (grant) =>
      grant.allow?.includes(PATCH) === true &&
      (grant.path === path || grant.path === directoryOf(path)),
  );
