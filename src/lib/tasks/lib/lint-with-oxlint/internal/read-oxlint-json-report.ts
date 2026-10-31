import { Effect, Schema } from "effect";

import { encodeJson } from "../../../shared/encode-compact-json.ts";
import { decodedReport } from "../../../shared/run-tools-and-decode-their-reports.ts";

const OXLINT_WARNING = "warning";
export const OXLINT_TASK = "oxlint";

const OXLINT_REPORT = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        message: Schema.String,
        code: Schema.optionalKey(Schema.String),
        severity: Schema.String,
        filename: Schema.String,
        labels: Schema.Array(
          Schema.Struct({
            span: Schema.Struct({
              line: Schema.NullOr(Schema.Int),
              column: Schema.NullOr(Schema.Int),
            }),
          }),
        ),
      }),
    ),
  }),
);

const oxlintError = (reported: (typeof OXLINT_REPORT.Type)["diagnostics"][number]) => {
  const label = reported.labels.find(({ span }) => span.line !== null)?.span;
  const location =
    label === undefined
      ? reported.filename
      : `${reported.filename}:${label.line}${label.column === null ? "" : `:${label.column}`}`;
  return { tag: reported.code ?? OXLINT_TASK, location, message: reported.message };
};

export const oxlintReport = (program: string, ...standardOutputs: readonly string[]) =>
  Effect.forEach(
    standardOutputs.filter((standardOutput) => standardOutput.trim() !== ""),
    (standardOutput) => decodedReport(program, Schema.decodeEffect(OXLINT_REPORT), standardOutput),
  ).pipe(
    Effect.map((reports) => {
      const diagnostics = reports.flatMap((report) => report.diagnostics);
      const warnings = diagnostics.filter((reported) => reported.severity === OXLINT_WARNING);
      return {
        violations: diagnostics
          .filter((reported) => reported.severity !== OXLINT_WARNING)
          .map((reported) => oxlintError(reported)),
        notes:
          warnings.length === 0
            ? []
            : [
                `${program} also reported ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}, which this printer cannot show as warnings`,
              ],
      };
    }),
  );

export const lintReportWithOriginalFileNames = (
  program: string,
  standardOutput: string,
  files: readonly string[],
) => {
  const keepsReport = standardOutput.trim() === "" || !files.some((file) => file.includes("\\"));
  if (keepsReport) {
    return Effect.succeed(standardOutput);
  }
  return decodedReport(program, Schema.decodeEffect(OXLINT_REPORT), standardOutput).pipe(
    Effect.flatMap((report) =>
      encodeJson({
        diagnostics: report.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          filename:
            files.find((file) => file.replaceAll("\\", "/") === diagnostic.filename) ??
            diagnostic.filename,
        })),
      }),
    ),
  );
};
