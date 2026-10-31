import { ReportedErrors } from "@sshkeda/task/errors";
import { Array as Arrays, Cause, Effect, Exit, Option, Result } from "effect";

import { printableErrorWith } from "../../../shared/format-reported-failures.ts";
import {
  couldNotRun,
  quietViolations,
} from "../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { CheckCrashed } from "../shared/project-config-and-tool-errors.ts";
import { openTypeScriptProjects } from "../shared/query-the-typescript-project.ts";

const OPENING_THE_PROJECT = "typescript-project";

export const runChecksOverOneTypeScriptProject = <Requirement>(
  projectFile: string,
  checks: Readonly<
    Record<
      string,
      (
        projectFile: string,
        openedProjects: Effect.Effect<Effect.Success<ReturnType<typeof openTypeScriptProjects>>>,
      ) => Effect.Effect<
        void,
        Effect.Error<Parameters<ReturnType<typeof quietViolations>>[0]>,
        Requirement
      >
    >
  >,
) =>
  Effect.gen(function* () {
    const openedProjects = Effect.succeed(
      yield* openTypeScriptProjects(projectFile).pipe(quietViolations(OPENING_THE_PROJECT)),
    );
    const results = yield* Effect.all(
      Object.entries(checks).map(([name, runCheck]) =>
        Effect.suspend(() => runCheck(projectFile, openedProjects)).pipe(
          quietViolations(name),
          Effect.exit,
          Effect.flatMap((exit) => {
            const defect = Exit.isFailure(exit)
              ? Result.getSuccess(Cause.findDefect(exit.cause))
              : Option.none();
            return Option.match(defect, {
              onNone: () => exit,
              onSome: (crash) =>
                couldNotRun(
                  name,
                  new CheckCrashed({ check: name, reason: Cause.pretty(Cause.die(crash)) }),
                ),
            });
          }),
          Effect.mapError(({ reportedErrors }) =>
            Arrays.map(reportedErrors, (reported) =>
              printableErrorWith(reported, { tag: `${name} ${reported.tag}` }),
            ),
          ),
          Effect.withSpan(name),
        ),
      ),
      { concurrency: "unbounded", mode: "result" },
    );
    const reportedErrors = results.flatMap((result) =>
      Result.isFailure(result) ? result.failure : [],
    );
    if (Arrays.isArrayNonEmpty(reportedErrors)) {
      return yield* new ReportedErrors({ reportedErrors });
    }
  }).pipe(Effect.scoped);
