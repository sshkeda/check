import { Effect, FileSystem, Path } from "effect";

import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { isFormatConfigTextRefusedIn } from "../../../shared/parse-config-files-that-import-from-check.ts";
import { quietToolFailure } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { TYPESCRIPT_PROJECT_FILE } from "../../../shared/query-the-typescript-project.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import { runTool } from "../../../shared/run-tools-and-decode-their-reports.ts";
import { typeCheckReport } from "./read-bun-check-output.ts";

const BUN = "bun";
const EMPTY_PACKAGE_MANIFEST = "{}\n";

const typeCheckRun = (directory: string, isFormatConfigRefused: boolean) =>
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
          ? Effect.void
          : Effect.fail(exited),
      ),
    );
  }).pipe(
    Effect.scoped,
    quietToolFailure("type-check", (exited) =>
      Effect.succeed(typeCheckReport(exited.standardOutput, isFormatConfigRefused)),
    ),
  );

export const checkTypesWithBunCheckIn = (directory: string) =>
  Effect.flatMap(isFormatConfigTextRefusedIn(directory), (isFormatConfigRefused) =>
    typeCheckRun(directory, isFormatConfigRefused),
  );
