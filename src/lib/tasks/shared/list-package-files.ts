import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option, Path, References } from "effect";

import { enclosingDirectoriesOf } from "./classify-files-by-role.ts";
import { PACKAGE_MANIFEST_FILE } from "./find-named-package-manifests.ts";
import { isSymbolicLink } from "./find-symbolic-links.ts";
import { namedPackageManifestAt } from "./read-named-package-manifests.ts";

const isNamedPackageDirectory = (directory: string) =>
  Path.Path.use((path) =>
    namedPackageManifestAt(path.join(directory, PACKAGE_MANIFEST_FILE)).pipe(
      Effect.map(Option.isSome),
    ),
  );

export const nestedPackageDirectoriesAmong = (
  packageDirectory: string,
  relativePaths: readonly string[],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const nestedPackageDirectories = yield* Effect.filter(
      new Set(relativePaths.flatMap((relativePath) => enclosingDirectoriesOf(relativePath))),
      (directory) => isNamedPackageDirectory(path.join(packageDirectory, directory)),
      { concurrency: "unbounded" },
    );
    return nestedPackageDirectories.toSorted();
  });

export const isInsideAnyDirectory = (relativePath: string, directories: readonly string[]) =>
  directories.some((directory) => relativePath.startsWith(`${directory}/`));

const isExistingNonDirectory = (location: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(location);
    if (!exists) {
      return false;
    }
    if (yield* isSymbolicLink(location)) {
      return true;
    }
    return (yield* fileSystem.stat(location)).type !== "Directory";
  });

const existingListedFiles = (packageDirectory: string, pathspecs: readonly string[]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const listed = yield* Task.exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs],
      { cwd: packageDirectory },
    ).pipe(Effect.provideService(References.MinimumLogLevel, "Warn"));
    return yield* Effect.filter(
      new Set(listed.split("\0").filter((file) => file !== "")),
      (file) => isExistingNonDirectory(path.join(packageDirectory, file)),
      { concurrency: "unbounded" },
    );
  });

export const listedPackageFiles = (packageDirectory: string, pathspecs: readonly string[]) =>
  Effect.gen(function* () {
    const existing = yield* existingListedFiles(packageDirectory, pathspecs);
    const nestedPackageDirectories = yield* nestedPackageDirectoriesAmong(
      packageDirectory,
      existing,
    );
    return {
      packageFiles: existing
        .filter((file) => !isInsideAnyDirectory(file, nestedPackageDirectories))
        .toSorted(),
      nestedPackageDirectories,
    };
  });

export const existingPackageFiles = (packageDirectory: string, pathspecs: readonly string[]) =>
  listedPackageFiles(packageDirectory, pathspecs).pipe(
    Effect.map(({ packageFiles }) => packageFiles),
  );
