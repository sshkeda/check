import { Effect, Schema } from "effect";

import { distinctPrintedErrors } from "../../../shared/check-each-nested-package.ts";
import { decodedReport } from "../../../shared/run-tools-and-decode-their-reports.ts";

const PROJECT_WIDE_DIAGNOSTICS: ReadonlySet<string> = new Set(["duplicatePackage"]);

const UPSTREAM_MESSAGE_REWRITES: ReadonlyMap<string, string> = new Map([
  ["effect(schemaNumber)", "Schema.Number accepts NaN, Infinity and -Infinity"],
]);

const EFFECT_VIOLATIONS_REPORT = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        file: Schema.String,
        line: Schema.Int,
        column: Schema.Int,
        name: Schema.String,
        message: Schema.String,
      }),
    ),
  }),
);

export const effectViolationsReport = (program: string, standardOutput: string) =>
  standardOutput.trim() === ""
    ? Effect.succeed({ violations: [], notes: [] })
    : decodedReport(program, Schema.decodeEffect(EFFECT_VIOLATIONS_REPORT), standardOutput).pipe(
        Effect.map((report) => ({
          violations: distinctPrintedErrors(
            report.diagnostics.map((reported) => {
              const tag = `effect(${reported.name})`;
              const message = UPSTREAM_MESSAGE_REWRITES.get(tag) ?? reported.message;
              const location = `${reported.file}:${reported.line}:${reported.column}`;
              return PROJECT_WIDE_DIAGNOSTICS.has(reported.name)
                ? { tag, message }
                : { tag, location, message };
            }),
          ),
          notes: [],
        })),
      );
