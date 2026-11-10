import { Effect, FileSystem, Path } from "effect";

import { listedBinaryFilesOf } from "../../../shared/find-installed-package-binaries.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { existingPackageFiles } from "../../../shared/list-package-files.ts";
import { rootManifestIn } from "../../../shared/match-granted-patch-files.ts";
import { ShebangOutsideBin, ShebangsOutsideBin } from "./shebang-errors.ts";

const SHEBANG = /^﻿?#!/u;

const FIRST_LINE = 1;

export const findShebangsOutsideBin = (directory: string, files: readonly string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binaryFiles = listedBinaryFilesOf(
      yield* rootManifestIn(
        directory,
        yield* existingPackageFiles(directory, [PACKAGE_MANIFEST_FILE]),
      ),
    );
    const startingWithAShebang = yield* Effect.filter(
      files.filter((file) => !binaryFiles.has(file)),
      (file) =>
        fileSystem
          .readFileString(path.join(directory, file))
          .pipe(Effect.map((text) => SHEBANG.test(text))),
      { concurrency: "unbounded" },
    );
    if (startingWithAShebang.length > 0) {
      return yield* new ShebangsOutsideBin({
        violations: startingWithAShebang.map(
          (file) => new ShebangOutsideBin({ location: `${file}:${FIRST_LINE}` }),
        ),
      });
    }
  });
