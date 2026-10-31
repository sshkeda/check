import { Task } from "@sshkeda/task";
import { Effect, Schema } from "effect";

import { makeProject } from "./checked-project.ts";
import { oxlintBinary } from "./oxlint-binary.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const lintErrorsOfGrantedCases = <Failure, Requirements>(
  parseReport: (
    program: string,
    ...standardOutputs: readonly string[]
  ) => Effect.Effect<
    {
      readonly violations: readonly {
        readonly location: string;
        readonly tag: string;
        readonly message: string;
      }[];
    },
    Failure,
    Requirements
  >,
  compilerRequirements: Readonly<Record<string, Schema.Json>>,
  directory: string,
  cases: readonly { readonly code: string; readonly allow: readonly string[] }[],
  enclosingGrants: Readonly<Record<string, { readonly allow: readonly string[] }>> = {},
) =>
  Effect.gen(function* () {
    const fileOf = (index: number) => `${directory}/case-${index}.ts`;
    const grants = {
      ...enclosingGrants,
      ...Object.fromEntries(
        cases.flatMap(({ allow }, index) =>
          allow.length === 0 ? [] : [[fileOf(index), { allow }]],
        ),
      ),
    };
    const project = yield* makeProject(
      compilerRequirements,
      Object.fromEntries(cases.map(({ code }, index) => [fileOf(index), `${code}\n`])),
      `lintConfig(${yield* encodeJson(grants)})`,
    );
    const output = yield* Task.exec(
      "bun",
      [yield* oxlintBinary, "--config", "oxlint.config.ts", "--format", "json", directory],
      { cwd: project.directory },
    ).pipe(
      Effect.as(""),
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    const { violations } = yield* parseReport("oxlint", output);
    return cases.map(({ code }, index) => ({
      code,
      errors: violations
        .filter(({ location }) => location.startsWith(`${fileOf(index)}:`))
        .map(({ tag, message }) => `${tag}: ${message}`)
        .toSorted(),
    }));
  }).pipe(Effect.scoped);

export const lintErrorsOfEachCase = <Failure, Requirements>(
  parseReport: Parameters<typeof lintErrorsOfGrantedCases<Failure, Requirements>>[0],
  compilerRequirements: Readonly<Record<string, Schema.Json>>,
  directory: string,
  cases: readonly string[],
  allow: readonly string[] = [],
) =>
  lintErrorsOfGrantedCases(
    parseReport,
    compilerRequirements,
    directory,
    cases.map((code) => ({ code, allow })),
  );
