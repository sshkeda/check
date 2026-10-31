import { Effect, FileSystem, Path } from "effect";

import { isScript, SCRIPT_EXTENSIONS } from "./classify-files-by-role.ts";
import { ignoredFilesImportedIn } from "./list-ignored-files-imported-by-source.ts";
import { ownedFilesAmong } from "./list-owned-files.ts";
import { existingPackageFiles } from "./list-package-files.ts";
import { programFiles } from "./query-the-typescript-project.ts";

const SCRIPT_PATHSPECS = SCRIPT_EXTENSIONS.map((extension) => `*${extension}`);

export const scriptFiles = (projectFile: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tracked = yield* existingPackageFiles(path.dirname(projectFile), SCRIPT_PATHSPECS);
    const compiled = yield* programFiles(projectFile);
    const imported = yield* Effect.filter(
      (yield* ignoredFilesImportedIn(projectFile)).filter((file) => isScript(file)),
      (file) => fileSystem.exists(path.join(path.dirname(projectFile), file)),
    );
    return [...new Set([...tracked, ...compiled, ...imported])].toSorted();
  });

export const lintedFiles = (projectFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* ownedFilesAmong(path.dirname(projectFile), yield* scriptFiles(projectFile));
  });
