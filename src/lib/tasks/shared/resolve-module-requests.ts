import { Effect, FileSystem, Option, Path, Result } from "effect";

import { moduleResolverFor } from "./create-the-module-resolver.ts";
import { withoutQuery } from "./find-module-requests.ts";
import {
  directoriesAFailedResolutionReads,
  enclosingPackageManifestsOf,
  resolutionNamesNoFile,
} from "./find-named-package-manifests.ts";
import { ModuleRequestUnresolvable } from "./project-config-and-tool-errors.ts";
import { namedPackageManifestAt } from "./read-named-package-manifests.ts";

const HASH_AFTER_THE_FIRST_CHARACTER = /(?<!^)#/gu;
const HASH_THE_RESOLVER_READS_AS_A_CHARACTER = "\0#";

const UNNAMED_PACKAGE = { name: null, hasExports: false, realPath: null } as const;

const packagesByDirectory = new Map<
  string,
  {
    readonly name: string | null;
    readonly hasExports: boolean;
    readonly realPath: string | null;
  }
>();

const realPathOf = (file: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.realPath(file));

const namedManifestAt = (manifestFile: string) =>
  namedPackageManifestAt(manifestFile).pipe(
    Effect.map(
      Option.match({
        onNone: () => Result.failVoid,
        onSome: (manifest) => Result.succeed({ manifestFile, manifest }),
      }),
    ),
  );

const namedPackageEnclosing = Effect.fn("namedPackageEnclosing")(function* (
  directory: string,
  projectDirectory: string,
) {
  const key = `${projectDirectory}\0${directory}`;
  const known = packagesByDirectory.get(key);
  if (known !== undefined) {
    return known;
  }
  const path = yield* Path.Path;
  const named = yield* Effect.findFirstFilter(
    enclosingPackageManifestsOf(directory, projectDirectory),
    namedManifestAt,
  );
  const identity = Option.isNone(named)
    ? UNNAMED_PACKAGE
    : {
        name: named.value.manifest.name,
        hasExports: named.value.manifest.hasExports,
        realPath: yield* realPathOf(path.dirname(named.value.manifestFile)),
      };
  packagesByDirectory.set(key, identity);
  return identity;
});

export const resolveModuleRequest = Effect.fn("resolveModuleRequest")(function* ({
  request,
  importingFile,
  customConditions,
  projectDirectory,
}: {
  readonly request: string;
  readonly importingFile: string;
  readonly customConditions: readonly string[];
  readonly projectDirectory: string;
}) {
  const path = yield* Path.Path;
  const unresolvable = (reason: string) =>
    new ModuleRequestUnresolvable({ request, importingFile, reason });
  const packageEnclosing = (directory: string) =>
    namedPackageEnclosing(directory, projectDirectory).pipe(
      Effect.catchTags({
        PackageManifestUnreadable: (error) =>
          Effect.fail(
            unresolvable(`${path.relative(projectDirectory, error.location)} ${error.message}`),
          ),
        PlatformError: (error) => Effect.fail(unresolvable(error.message)),
      }),
    );
  const fileRequest = withoutQuery(request);
  const resolverRequest = fileRequest.replaceAll(
    HASH_AFTER_THE_FIRST_CHARACTER,
    HASH_THE_RESOLVER_READS_AS_A_CHARACTER,
  );
  const resolved = yield* Effect.tryPromise({
    try: () => moduleResolverFor(customConditions).resolveFileAsync(importingFile, resolverRequest),
    catch: (cause) => unresolvable(String(cause)),
  });
  const resolvedFile = resolved.path;
  if (resolvedFile === undefined) {
    yield* Effect.forEach(
      directoriesAFailedResolutionReads({ importingFile, request: fileRequest }),
      packageEnclosing,
      { discard: true },
    );
    const reason = resolved.error ?? "the resolver returned no file and no error";
    const namesNoFile = resolutionNamesNoFile(resolved, reason);
    if (namesNoFile) {
      return;
    }
    return yield* unresolvable(reason);
  }
  const identity = yield* packageEnclosing(path.dirname(resolvedFile));
  return {
    file: yield* realPathOf(resolvedFile).pipe(
      Effect.mapError((error) => unresolvable(error.message)),
    ),
    packageName: identity.name,
    packageHasExports: identity.hasExports,
    packageRoot: identity.realPath,
  };
});
