import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import {
  checkUnsafeEnumAssignmentsIn,
  checkUnsafeEnumAssignmentsWith,
} from "../../src/lib/tasks/lib/lint-with-oxlint/internal/check-unsafe-enum-assignments.ts";
import {
  EnumLintFailed,
  tsgolintRuleMessages,
} from "../../src/lib/tasks/lib/lint-with-oxlint/internal/read-tsgolint-rule-messages.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  makeProject as makeProjectWith,
  RUNNER,
  writtenFiles,
  stagedCheckModule,
} from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { ruleTestWith } from "../shared/rule-test.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const COMPATIBILITY_VIOLATIONS = 2;

const UNSORTED_UNIONS = 400;

const LINT_TASK = stagedCheckModule("src/lib/tasks/lib/lint-with-oxlint/index.ts");

const OWNER_RUNS_EVERYONE_READS = 0o755;

const lintOutputOf = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* makeProject(files);
    yield* writtenFiles(directory, {
      "run.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { oxlint } from ${yield* encodeJson(LINT_TASK)};\nTask.main(oxlint);\n`,
      ".gitignore": "node_modules\nrun.ts\n",
    });
    return yield* runTaskFile("bun run.ts", { cwd: directory, taskStateDirectory }).pipe(
      Effect.catchTag("CommandFailed", (failure) =>
        Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
      ),
    );
  });

const reportedErrorsOfAFakeTsgolint = (script: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const binary = path.join(directory, "tsgolint");
    yield* fileSystem.writeFileString(binary, `#!/bin/sh\ncat > /dev/null\n${script}\n`);
    yield* fileSystem.chmod(binary, OWNER_RUNS_EVERYONE_READS);
    const failure = yield* checkUnsafeEnumAssignmentsWith(binary, directory, []).pipe(
      failureAsValue,
    );
    return failure.reportedErrors;
  });

export const preservesEnumAssignmentsAndTypeSorting = Task.make(
  "standalone lint preserves unsafe enum assignment and type sorting messages, and accepts enum members and sorted unions",
  Effect.scoped(
    Effect.gen(function* () {
      const output = yield* lintOutputOf({
        "src/unsafe.ts": [
          "enum Mode { First }",
          "export const MODE: Mode = 0;",
          "export const choose = (value: string | number) => value;",
          "",
        ].join("\n"),
        "src/safe.ts": [
          "enum Mode { First }",
          "export const MODE: Mode = Mode.First;",
          "export const choose = (value: number | string) => value;",
          "",
        ].join("\n"),
      });
      expect(output).toContain(
        "error typescript(no-unsafe-enum-assignment): The value assigned here does not have a shared enum type with the expected enum 'Mode'.",
      );
      expect(output).toMatch(
        /error sshkeda\(no-unsorted-type-constituents\): Union type constituents must be sorted$/mu,
      );
      const compatibilityReports = output
        .split("\n")
        .filter(
          (line) =>
            line.includes("error typescript(no-unsafe-enum-assignment)") ||
            line.includes("error sshkeda(no-unsorted-type-constituents)"),
        );
      expect(compatibilityReports).toHaveLength(COMPATIBILITY_VIOLATIONS);
      expect(compatibilityReports.join("\n")).not.toContain("src/safe.ts:");
      expect(output).not.toContain("EnumLintFailed");
      expect(output).toMatch(/^\[oxlint\] error ToolExited: oxlint exited with code 1$/mu);
      expect(output).toMatch(
        /^\[oxlint\] error ToolReportedViolations: tsgolint reported 1 violation and exited with code 0$/mu,
      );
    }),
  ),
);

export const readsAnOxlintReportLargerThanAPipeBuffer = Task.make(
  "an oxlint report larger than 64 KB decodes and reports every finding",
  Effect.scoped(
    Effect.gen(function* () {
      const output = yield* lintOutputOf({
        "src/unsorted.ts": Array.from(
          { length: UNSORTED_UNIONS },
          (_entry, index) => `export type Choice${index} = string | number;`,
        ).join("\n"),
      });
      expect(output).not.toContain("ToolReportUndecodable");
      expect(
        output
          .split("\n")
          .filter((line) => line.includes("error sshkeda(no-unsorted-type-constituents)")),
      ).toHaveLength(UNSORTED_UNIONS);
    }),
  ),
);

export const namesTsgolintWithTheViolationsItReports = Task.make(
  "unsafe enum assignments end with a line that names tsgolint and its real exit code, not an oxlint exit",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* writtenFiles(directory, {
        "tsconfig.json": yield* encodeJson({ compilerOptions: { strict: true }, files: ["a.ts"] }),
        "a.ts": "enum Mode { First }\nexport const MODE: Mode = 0;\n",
      });
      const failure = yield* checkUnsafeEnumAssignmentsIn(directory, ["a.ts"]).pipe(failureAsValue);
      expect(failure.reportedErrors).toEqual([
        {
          tag: "typescript(no-unsafe-enum-assignment)",
          location: "a.ts:2:14",
          message:
            "The value assigned here does not have a shared enum type with the expected enum 'Mode'.",
        },
        {
          tag: "ToolReportedViolations",
          message: "tsgolint reported 1 violation and exited with code 0",
        },
      ]);
    }),
  ),
);

export const namesTsgolintAndItsExitCode = Task.make(
  "a tsgolint that exits with a nonzero code is reported with that code and its standard error",
  Effect.scoped(
    Effect.gen(function* () {
      expect(yield* reportedErrorsOfAFakeTsgolint("echo broken >&2\nexit 3")).toEqual([
        { tag: "ToolExited", message: "tsgolint exited with code 3\nbroken" },
      ]);
    }),
  ),
);

export const namesTheSignalThatStoppedTsgolint = Task.make(
  "a tsgolint stopped by a signal is reported with that signal",
  Effect.scoped(
    Effect.gen(function* () {
      expect(yield* reportedErrorsOfAFakeTsgolint("kill -9 $$")).toEqual([
        { tag: "ToolStoppedBySignal", message: "tsgolint was stopped by signal SIGKILL" },
      ]);
    }),
  ),
);

export const refusesATruncatedEnumReport = Task.make(
  "a truncated enum backend report fails instead of silently dropping its findings",
  Effect.sync(() => {
    const header = Buffer.from([1, 0, 0, 0, 1]);
    expect(() => tsgolintRuleMessages(header)).toThrow("truncated message body");
  }),
);

export const namesMalformedEnumReports = Task.make(
  "malformed enum backend errors and diagnostics fail with EnumLintFailed",
  Effect.sync(() => {
    const body = Buffer.from("{}");
    for (const kind of [0, 1]) {
      const header = Buffer.from([0, 0, 0, 0, kind]);
      header.writeUInt32LE(body.length, 0);
      expect(() => tsgolintRuleMessages(Buffer.concat([header, body]))).toThrow(EnumLintFailed);
    }
  }),
);

export const preservesTypeSortingDefaults = Task.make(
  "type sorting preserves numeric and case ordering, group ordering, intersections and named parenthesized unions",
  ruleTest("no-unsorted-type-constituents", {
    valid: [
      "type Choice = number | string;",
      "type Choice = A2 | A10;",
      "type Choice = A | a;",
      "type Choice = A | number | undefined;",
      "type Both = A & Z;",
    ],
    invalid: [
      {
        code: "type Choice = (string | number);",
        errors: [{ messageId: "notSortedNamed", data: { type: "Union", name: "Choice" } }],
      },
      {
        code: "type Choice = (Z) | A;",
        errors: [{ messageId: "notSortedNamed", data: { type: "Union", name: "Choice" } }],
      },
      {
        code: "type Choice = A10 | A2;",
        errors: [{ messageId: "notSortedNamed", data: { type: "Union", name: "Choice" } }],
      },
      {
        code: "type Choice = a | A;",
        errors: [{ messageId: "notSortedNamed", data: { type: "Union", name: "Choice" } }],
      },
      {
        code: "type Choice = undefined | number | A;",
        errors: [{ messageId: "notSortedNamed", data: { type: "Union", name: "Choice" } }],
      },
      {
        code: "type Both = Z & A;",
        errors: [{ messageId: "notSortedNamed", data: { type: "Intersection", name: "Both" } }],
      },
    ],
  }),
);
