import { Effect, FileSystem, Option } from "effect";

import { directoryHolding } from "../../../shared/match-file-names-and-path-prefixes.ts";
import {
  namedPackageManifestIn,
  namesASymlinkLoop,
  namesNoManifest,
  unreadableManifestReason,
} from "./find-named-package-manifests.ts";
import { PackageManifestUnreadable } from "./project-config-and-tool-errors.ts";

const manifestBytesAt = (manifestFile: string) =>
  FileSystem.FileSystem.use((fileSystem) =>
    Effect.gen(function* () {
      const isManifestFile = yield* fileSystem.stat(manifestFile).pipe(
        Effect.map((information) => information.type === "File"),
        Effect.catchTag("PlatformError", (error) => {
          if (namesNoManifest(error.reason.cause)) {
            return Effect.succeed(false);
          }
          if (!namesASymlinkLoop(error.reason.cause)) {
            return Effect.fail(error);
          }
          return fileSystem.stat(directoryHolding(manifestFile)).pipe(
            Effect.as(true),
            Effect.catchTag("PlatformError", (directoryError) =>
              namesASymlinkLoop(directoryError.reason.cause)
                ? Effect.succeed(false)
                : Effect.fail(error),
            ),
            Effect.filterOrFail(
              (isDirectoryReadable) => !isDirectoryReadable,
              () => error,
            ),
          );
        }),
      );
      return isManifestFile
        ? Option.some(yield* fileSystem.readFile(manifestFile))
        : Option.none<Uint8Array>();
    }),
  ).pipe(Effect.mapError((error) => unreadableManifestReason(error.reason.cause)));

export const namedPackageManifestAt = (manifestFile: string) =>
  manifestBytesAt(manifestFile).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (bytes) => Effect.fromResult(namedPackageManifestIn(bytes)),
      }),
    ),
    Effect.mapError((reason) => new PackageManifestUnreadable({ location: manifestFile, reason })),
  );
