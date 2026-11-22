import { Effect, FileSystem, Path, Ref } from "effect";

import { inEachPackage } from "../../../shared/check-each-nested-package.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { isFormatConfigTextRefusedIn } from "../../../shared/parse-config-files-that-import-from-check.ts";
import { quietToolFailure } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { TYPESCRIPT_PROJECT_FILE } from "../../../shared/query-the-typescript-project.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import { runTool } from "../../../shared/run-tools-and-decode-their-reports.ts";
import { formatting } from "../../format-with-bun-fmt/index.ts";
import { typeCheckReport } from "./read-bun-check-output.ts";

const BUN = "bun";
const EMPTY_PACKAGE_MANIFEST = "{}\n";

const typeCheckRun = (
  directory: string,
  isFormatConfigRefused: boolean,
  leaveToTheFormatCheck: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directoryWithoutPackageScripts = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.writeFileString(
      path.join(directoryWithoutPackageScripts, PACKAGE_MANIFEST_FILE),
      EMPTY_PACKAGE_MANIFEST,
    );
    yield* runTool(
      BUN,
      BUN,
      [
        "check",
        "--project",
        TYPESCRIPT_PROJECT_FILE,
        "--no-pretty",
        "--all",
        "--build",
        `--cwd=${yield* absolutePathOf(directory)}`,
      ],
      directoryWithoutPackageScripts,
    ).pipe(
      Effect.catchTag("ToolExited", (exited) =>
        typeCheckReport(exited.standardOutput, isFormatConfigRefused)
          .reportsOnlyWhatTheFormatCheckReports
          ? leaveToTheFormatCheck
          : Effect.fail(exited),
      ),
    );
  }).pipe(
    Effect.scoped,
    quietToolFailure("type-check", (exited) =>
      Effect.succeed(typeCheckReport(exited.standardOutput, isFormatConfigRefused)),
    ),
  );

const checkTypesWithBunCheckIn = (directory: string, leaveToTheFormatCheck: Effect.Effect<void>) =>
  Effect.flatMap(isFormatConfigTextRefusedIn(directory), (isFormatConfigRefused) =>
    typeCheckRun(directory, isFormatConfigRefused, leaveToTheFormatCheck),
  );

export const typesCheckedInEachPackage = Effect.gen(function* () {
  const isLeftToTheFormatCheck = yield* Ref.make(false);
  yield* inEachPackage("type-check", (packageDirectory) =>
    checkTypesWithBunCheckIn(packageDirectory, Ref.set(isLeftToTheFormatCheck, true)),
  );
  if (yield* Ref.get(isLeftToTheFormatCheck)) {
    yield* formatting;
  }
});
