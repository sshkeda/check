import { ReportedErrors } from "@sshkeda/task/errors";
import type { PrintableError } from "@sshkeda/task/errors";
import { Array as Arrays, Cause, Effect, Predicate, Schema } from "effect";

import { printableError } from "../../../shared/format-reported-failures.ts";
import { ToolExited } from "./project-config-and-tool-errors.ts";
import type { ToolReportUndecodable } from "./project-config-and-tool-errors.ts";

const isToolExited = Schema.is(ToolExited);

const annotateFailure = (tool: string, failure: Parameters<typeof printableError>[0]) => {
  const hasCommand =
    Predicate.hasProperty(failure, "command") && Predicate.isString(failure.command);
  return Effect.annotateCurrentSpan({
    "check.tool": tool,
    "check.failure": Cause.pretty(Cause.fail(failure)),
    ...(hasCommand ? { "check.command": failure.command } : {}),
  });
};

export const failQuietly = (
  tool: string,
  failure: Parameters<typeof printableError>[0],
  reportedErrors: Arrays.NonEmptyReadonlyArray<PrintableError>,
) =>
  Effect.gen(function* () {
    yield* annotateFailure(tool, failure);
    return yield* new ReportedErrors({ reportedErrors: [...reportedErrors] });
  });

export const couldNotRun = (tool: string, failure: Parameters<typeof printableError>[0]) =>
  failQuietly(tool, failure, [printableError(failure)]);

const eachViolationOf = (
  failure: Parameters<typeof printableError>[0] & {
    readonly violations?: readonly Parameters<typeof printableError>[0][];
  },
) => {
  const hasViolations =
    failure.violations !== undefined && Arrays.isReadonlyArrayNonEmpty(failure.violations);
  return new ReportedErrors({
    reportedErrors: hasViolations
      ? Arrays.map(failure.violations, printableError)
      : [printableError(failure)],
  });
};

const exitError = (exited: ToolExited, notes: readonly string[]): PrintableError => ({
  tag: exited._tag,
  message: [`${exited.program} exited with code ${exited.code}`, ...notes, exited.standardError]
    .filter((line) => line !== "")
    .join("\n"),
});

export const quietToolFailure =
  <ReportRequirements = never>(
    tool: string,
    reportOf: (exited: ToolExited) => Effect.Effect<
      {
        readonly violations: readonly PrintableError[];
        readonly notes: readonly string[];
      },
      ToolReportUndecodable,
      ReportRequirements
    >,
  ) =>
  <Success, Failure extends Parameters<typeof eachViolationOf>[0], Requirements>(
    effect: Effect.Effect<Success, Failure | ToolExited, Requirements>,
  ): Effect.Effect<Success, ReportedErrors, ReportRequirements | Requirements> =>
    effect.pipe(
      Effect.tapError((error) =>
        isToolExited(error) ? Effect.void : annotateFailure(tool, error),
      ),
      Effect.mapError((error) => (isToolExited(error) ? error : eachViolationOf(error))),
      Effect.catchTag("ToolExited", (exited) =>
        reportOf(exited).pipe(
          Effect.flatMap((report) =>
            failQuietly(
              tool,
              exited,
              Arrays.append(report.violations, exitError(exited, report.notes)),
            ),
          ),
          Effect.catchTag("ToolReportUndecodable", (unreadableReport) =>
            failQuietly(tool, exited, [printableError(unreadableReport), exitError(exited, [])]),
          ),
        ),
      ),
    );

export const quietViolations =
  (tool: string) =>
  <Success, Requirements>(
    effect: Effect.Effect<Success, Parameters<typeof eachViolationOf>[0], Requirements>,
  ): Effect.Effect<Success, ReportedErrors, Requirements> =>
    effect.pipe(
      Effect.tapError((failure) => annotateFailure(tool, failure)),
      Effect.mapError(eachViolationOf),
    );
