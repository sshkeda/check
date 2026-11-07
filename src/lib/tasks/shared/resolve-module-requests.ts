import { Context, Effect, FileSystem, Layer, Option, Path, Result } from "effect";
import type { PlatformError } from "effect";

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

const namedManifestAt = (manifestFile: string) =>
  namedPackageManifestAt(manifestFile).pipe(
    Effect.map(
      Option.match({
        onNone: () => Result.failVoid,
        onSome: (manifest) => Result.succeed({ manifestFile, manifest }),
      }),
    ),
  );

const makeModuleResolutions = Effect.sync(() => {
  const packagesByDirectory = new Map<
    string,
    {
      readonly name: string | null;
      readonly hasExports: boolean;
      readonly realPath: string | null;
    }
  >();

  const realPathsByFile = new Map<string, Effect.Effect<string, PlatformError.PlatformError>>();

  const realPathOf = (file: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cachedRealPath =
        realPathsByFile.get(file) ?? (yield* Effect.cached(fileSystem.realPath(file)));
      realPathsByFile.set(file, cachedRealPath);
      return yield* cachedRealPath;
    });

  const namedPackageEnclosing = (directory: string, projectDirectory: string) =>
    Effect.gen(function* () {
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

  const resolveUncachedModuleRequest = ({
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
      const resolver = yield* moduleResolverFor(customConditions);
      const resolved = yield* Effect.tryPromise({
        try: () => resolver.resolveFileAsync(importingFile, resolverRequest),
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

  const resolutionsByRequest = new Map<string, ReturnType<typeof resolveUncachedModuleRequest>>();

  return {
    resolveModuleRequest: (resolution: Parameters<typeof resolveUncachedModuleRequest>[0]) =>
      Effect.gen(function* () {
        const key = [
          resolution.projectDirectory,
          resolution.importingFile,
          resolution.request,
          ...resolution.customConditions,
        ].join("\0");
        const cachedResolution =
          resolutionsByRequest.get(key) ??
          (yield* Effect.cached(resolveUncachedModuleRequest(resolution)));
        resolutionsByRequest.set(key, cachedResolution);
        return yield* cachedResolution;
      }),
  };
});

class ModuleResolutions extends Context.Service<
  ModuleResolutions,
  Effect.Success<typeof makeModuleResolutions>
>()("@sshkeda/check/ModuleResolutions") {}

export const ModuleResolutionsLive = Layer.effect(ModuleResolutions, makeModuleResolutions);

export const resolveModuleRequest = (
  resolution: Parameters<Effect.Success<typeof makeModuleResolutions>["resolveModuleRequest"]>[0],
) => ModuleResolutions.use((resolutions) => resolutions.resolveModuleRequest(resolution));
