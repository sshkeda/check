import { Effect, FileSystem, Path, Predicate, Schema } from "effect";

import { normalizedPath } from "../../../shared/record-and-grant-permissions-by-path.ts";
import { PACKAGE_MANIFEST_FILE } from "./find-named-package-manifests.ts";
import {
  InstalledPackageHasNoBinary,
  PackageManifestFieldInvalid,
  PackageNotInstalled,
} from "./project-config-and-tool-errors.ts";
import { packageManifestObject } from "./read-package-manifest-object.ts";
import type { JSON_OBJECT } from "./read-package-manifest-object.ts";

const MANIFEST_BINARIES = Schema.Struct({
  bin: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
  ),
});

const isManifestWithBinaries = Schema.is(MANIFEST_BINARIES);

export const listedBinaryFilesOf = (manifest: typeof JSON_OBJECT.Type) => {
  const bin = isManifestWithBinaries(manifest) ? manifest.bin : undefined;
  const binaries = Predicate.isString(bin) ? [bin] : Object.values(bin ?? {});
  return new Set(binaries.map((binary) => normalizedPath(binary)));
};

const unscopedName = (packageName: string) => packageName.split("/").at(-1) ?? packageName;

const declaredBinary = (
  bin: (typeof MANIFEST_BINARIES.Type)["bin"],
  packageName: string,
  binaryName: string,
) => {
  if (Predicate.isString(bin)) {
    return binaryName === unscopedName(packageName) ? bin : undefined;
  }
  return bin?.[binaryName];
};

export const installedBinary = (
  packageDirectory: string,
  packageName: string,
  binaryName: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const manifestFile = yield* Effect.tryPromise({
      try: () => Bun.resolve(`${packageName}/${PACKAGE_MANIFEST_FILE}`, packageDirectory),
      catch: (cause) =>
        new PackageNotInstalled({
          packageName,
          packageDirectory,
          reason: String(cause),
        }),
    });
    const manifestText = yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) => fileSystem.readFileString(manifestFile)),
    );
    const manifestObject = yield* Effect.fromResult(
      packageManifestObject(manifestFile, manifestText),
    );
    const { bin } = yield* Schema.decodeEffect(MANIFEST_BINARIES)(manifestObject).pipe(
      Effect.mapError(
        (error) => new PackageManifestFieldInvalid({ path: manifestFile, reason: error.message }),
      ),
    );
    const binary = declaredBinary(bin, packageName, binaryName);
    if (binary === undefined) {
      return yield* new InstalledPackageHasNoBinary({ packageName, binaryName });
    }
    return path.join(path.dirname(manifestFile), binary);
  });
