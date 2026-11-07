import { ReportedErrors } from "@sshkeda/task/errors";
import { Array as Arrays, Effect, Path } from "effect";

import { FORMAT_CONFIG_FILE, LINT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import { installedBinary } from "../../../shared/find-installed-package-binaries.ts";
import { lintedFiles } from "../../../shared/list-linted-files.ts";
import { isFormatConfigTextRefusedIn } from "../../../shared/parse-config-files-that-import-from-check.ts";
import {
  quietToolFailure,
  quietViolations,
} from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { ToolExited } from "../../../shared/project-config-and-tool-errors.ts";
import { TYPESCRIPT_PROJECT_FILE } from "../../../shared/query-the-typescript-project.ts";
import {
  argumentsInRunsOfBoundedSize,
  mergedExit,
  runTool,
} from "../../../shared/run-tools-and-decode-their-reports.ts";
import { checkUnsafeEnumAssignmentsIn } from "./check-unsafe-enum-assignments.ts";
import { tsgolintExecutable } from "./find-tsgolint-executable.ts";
import {
  OXLINT_TASK,
  oxlintReport,
  lintReportWithOriginalFileNames,
} from "./read-oxlint-json-report.ts";

const OXLINT = "oxlint";

const oxlintBinary = Effect.gen(function* () {
  const path = yield* Path.Path;
  const packageDirectory = yield* path.fromFileUrl(new URL(".", import.meta.url));
  return yield* installedBinary(packageDirectory, "oxlint", "oxlint");
});

const OXLINT_ARGUMENTS = [
  "--config",
  LINT_CONFIG_FILE,
  "--disable-nested-config",
  "--no-ignore",
  "--tsconfig",
  TYPESCRIPT_PROJECT_FILE,
  "--format",
  "json",
  "--",
] as const;

const exitsOfOxlintOn = (directory: string) => (files: readonly string[]) =>
  Effect.gen(function* () {
    const binary = yield* oxlintBinary;
    const backend = yield* tsgolintExecutable;
    return yield* runTool(
      OXLINT,
      process.execPath,
      [binary, ...OXLINT_ARGUMENTS, ...files],
      directory,
      { OXLINT_TSGOLINT_PATH: backend },
    );
  }).pipe(
    Effect.as([]),
    Effect.catchTag("ToolExited", (exited) =>
      lintReportWithOriginalFileNames(OXLINT, exited.standardOutput, files).pipe(
        Effect.map((standardOutput) => [
          new ToolExited({
            program: exited.program,
            command: exited.command,
            code: exited.code,
            standardError: exited.standardError,
            standardOutput,
          }),
        ]),
      ),
    ),
  );

const filesToLintIn = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const files = yield* lintedFiles(path.join(directory, TYPESCRIPT_PROJECT_FILE));
    const isFormatConfigRefused = yield* isFormatConfigTextRefusedIn(directory);
    return files.filter((file) => !isFormatConfigRefused || file !== FORMAT_CONFIG_FILE);
  }).pipe(quietViolations(OXLINT_TASK));

const checkLintRulesWithOxlintOn = (directory: string, files: readonly string[]) =>
  Effect.gen(function* () {
    const exits = yield* Effect.forEach(
      [
        ...argumentsInRunsOfBoundedSize(files.filter((file) => !file.includes("\\"))),
        ...files.filter((file) => file.includes("\\")).map((file) => [file]),
      ],
      exitsOfOxlintOn(directory),
    ).pipe(Effect.withSpan("lint-rules"), quietViolations(OXLINT_TASK));
    const flatExits = exits.flat();
    if (Arrays.isReadonlyArrayNonEmpty(flatExits)) {
      return yield* Effect.fail(mergedExit(flatExits)).pipe(
        quietToolFailure(OXLINT_TASK, (exited) =>
          oxlintReport(exited.program, ...flatExits.map(({ standardOutput }) => standardOutput)),
        ),
      );
    }
  });

const reportedErrorsOf = <Requirements>(check: Effect.Effect<void, ReportedErrors, Requirements>) =>
  check.pipe(
    Effect.as([]),
    Effect.catchTag("ReportedErrors", (reported) => Effect.succeed(reported.reportedErrors)),
  );

export const checkLintRulesWithOxlintIn = (directory: string) =>
  Effect.gen(function* () {
    const files = yield* filesToLintIn(directory);
    const reportedErrors = yield* Effect.all(
      [
        reportedErrorsOf(checkLintRulesWithOxlintOn(directory, files)),
        reportedErrorsOf(
          checkUnsafeEnumAssignmentsIn(directory, files).pipe(
            Effect.withSpan("unsafe-enum-assignments"),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const allReportedErrors = reportedErrors.flat();
    if (Arrays.isReadonlyArrayNonEmpty(allReportedErrors)) {
      return yield* new ReportedErrors({ reportedErrors: allReportedErrors });
    }
  });
