import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, References, Schema, Stream } from "effect";
import { parseSync } from "oxc-parser";

import { isFileSpecifier, packagePathOf } from "./classify-files-by-role.ts";
import { moduleRequestsIn } from "./find-module-requests.ts";
import {
  checkedSourceFiles,
  CUSTOM_CONDITIONS,
  effectiveCompilerOptions,
} from "./query-the-typescript-project.ts";
import { resolveModuleRequest } from "./resolve-module-requests.ts";

const CHECK_IGNORE_EXIT_CODE_WHEN_NO_PATH_IS_IGNORED = 1;
export const ignoredPackagePathsAmong = (
  packagePaths: readonly string[],
  packageDirectory: string,
) =>
  Effect.gen(function* () {
    const insidePackage = [...new Set(packagePaths)].filter(
      (packagePath) => packagePath !== "" && !packagePath.startsWith(".."),
    );
    if (insidePackage.length === 0) {
      return [];
    }
    const listed = yield* Task.exec("git", ["check-ignore", "--stdin", "-z"], {
      cwd: packageDirectory,
      stdin: Stream.encodeText(
        Stream.make(insidePackage.map((packagePath) => `${packagePath}\0`).join("")),
      ),
    }).pipe(
      Effect.provideService(References.MinimumLogLevel, "Warn"),
      Effect.catchTag("CommandFailed", (failure) =>
        failure.code === CHECK_IGNORE_EXIT_CODE_WHEN_NO_PATH_IS_IGNORED
          ? Effect.succeed("")
          : Effect.fail(failure),
      ),
    );
    return listed.split("\0").filter((ignoredPath) => ignoredPath !== "");
  });

export const ignoredFilesImportedIn = (projectFile: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDirectory = yield* fileSystem.realPath(path.dirname(projectFile));
    const { customConditions = [] } = yield* Schema.decodeEffect(CUSTOM_CONDITIONS)(
      yield* effectiveCompilerOptions(projectFile),
    );
    const importedPaths: string[] = [];
    for (const displayName of yield* checkedSourceFiles(projectFile)) {
      const importingFile = path.join(packageDirectory, displayName);
      const parsed = parseSync(displayName, yield* fileSystem.readFileString(importingFile));
      for (const { specifier } of moduleRequestsIn(parsed).requests) {
        if (isFileSpecifier(specifier)) {
          const importedFile =
            (yield* resolveModuleRequest({
              request: specifier,
              importingFile,
              customConditions,
              projectDirectory: packageDirectory,
            }))?.file ?? path.resolve(path.dirname(importingFile), specifier);
          importedPaths.push(packagePathOf(path, packageDirectory, importedFile));
        }
      }
    }
    const ignoredFiles: string[] = [];
    for (const ignoredPath of yield* ignoredPackagePathsAmong(importedPaths, packageDirectory)) {
      const absolutePath = path.join(packageDirectory, ignoredPath);
      const ignoredDirectoryIsNoImportedFile = yield* fileSystem.stat(absolutePath).pipe(
        Effect.map((information) => information.type === "Directory"),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      if (!ignoredDirectoryIsNoImportedFile) {
        ignoredFiles.push(ignoredPath);
      }
    }
    return ignoredFiles.toSorted();
  });
