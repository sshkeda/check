import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";
import { parseSync } from "oxc-parser";
import type { Expression } from "oxc-parser";

import plugin from "../../src/index.ts";
import { effectViolationsReport } from "../../src/lib/tasks/lib/check-effect-diagnostics-with-effect-tsgo/internal/read-effect-tsgo-json-report.ts";
import { pathViolations } from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import { oxlintReport } from "../../src/lib/tasks/lib/lint-with-oxlint/internal/read-oxlint-json-report.ts";
import { UnusedExport } from "../../src/lib/tasks/lib/place-exports-in-the-narrowest-directory/internal/export-placement-errors.ts";
import { DisableDirective } from "../../src/lib/tasks/lib/refuse-disable-directives/internal/disable-directive-errors.ts";
import { typeCheckReport } from "../../src/lib/tasks/lib/type-check-with-bun-check/internal/read-bun-check-output.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { recordedGrantsOf } from "../../src/shared/record-and-grant-permissions-by-path.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const isTaggedErrorFactory = (callee: Expression) =>
  callee.type === "CallExpression" &&
  callee.callee.type === "MemberExpression" &&
  callee.callee.object.type === "Identifier" &&
  callee.callee.object.name === "Schema" &&
  callee.callee.property.type === "Identifier" &&
  callee.callee.property.name === "TaggedError";

const declaredErrorTagsOf = (file: string, text: string) => {
  const { program, errors } = parseSync(file, text);
  expect({ file, parseErrors: errors.map(({ message }) => message) }).toEqual({
    file,
    parseErrors: [],
  });
  return program.body.flatMap((statement) => {
    if (statement.type !== "ExportNamedDeclaration") {
      return [];
    }
    if (statement.declaration?.type !== "ClassDeclaration") {
      return [];
    }
    const { id, superClass } = statement.declaration;
    const isTaggedErrorClass =
      id !== null &&
      superClass?.type === "CallExpression" &&
      isTaggedErrorFactory(superClass.callee);
    return isTaggedErrorClass ? [id.name] : [];
  });
};

export const everyRuleMessageStatesOneFact = Task.make({
  name: "every lint rule ID starts with no-, and every rule message is one line without a final period",
  run: Effect.sync(() => {
    const messages = Object.entries(plugin.rules).flatMap(([rule, definition]) =>
      Object.entries(definition.meta?.messages ?? {}).map(([messageId, message]) => ({
        id: `${rule}/${messageId}`,
        message,
      })),
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages
        .filter(({ message }) => message.includes("\n") || message.endsWith("."))
        .map(({ id }) => id),
    ).toEqual([]);
    expect(Object.keys(plugin.rules).filter((rule) => !rule.startsWith("no-"))).toEqual([]);
  }),
});

export const everyErrorTagIsConstructedInSource = Task.make({
  name: "every error and violation tag declared in an errors file is constructed with new <Tag>( somewhere else in src, so grepping a printed tag finds the code that raised it",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceDirectory = yield* path.fromFileUrl(new URL("../../src/", import.meta.url));
    const sourceFiles = (yield* fileSystem.glob("**/*.ts", { root: sourceDirectory })).map((file) =>
      path.join(sourceDirectory, file),
    );
    const files = yield* Effect.forEach(sourceFiles, (file) =>
      fileSystem
        .readFileString(file)
        .pipe(Effect.map((text) => ({ text, tags: declaredErrorTagsOf(file, text) }))),
    );
    const tags = files.flatMap((file) => file.tags);
    const sources = files.filter((file) => file.tags.length === 0).map((file) => file.text);
    expect(tags.filter((tag) => !sources.some((source) => source.includes(`new ${tag}(`)))).toEqual(
      [],
    );
  }),
});

export const violationsCarryEveryPrintedField = Task.make({
  name: "a violation becomes a printable error with the user's location, its tag and its message",
  run: Effect.sync(() => {
    const [misnamedFile] = pathViolations("BadName.ts");
    expect(misnamedFile === undefined ? undefined : printableError(misnamedFile)).toEqual({
      tag: "NotKebabCase",
      location: "BadName.ts",
      message: "BadName.ts is not kebab-case",
    });
    const recorded = recordedGrantsOf({ "src\\main.ts": { allow: ["readsConfig"] } });
    const [backslashes] = "violations" in recorded ? recorded.violations : [];
    expect(backslashes === undefined ? undefined : printableError(backslashes)).toEqual({
      tag: "MalformedGrant",
      location: "oxlint.config.ts",
      message: '"src\\main.ts": uses backslashes',
    });
    const unnormalized = recordedGrantsOf({ "./main.ts": { allow: ["readsConfig"] } });
    const [dotSegment] = "violations" in unnormalized ? unnormalized.violations : [];
    expect(dotSegment === undefined ? undefined : printableError(dotSegment)).toEqual({
      tag: "MalformedGrant",
      location: "oxlint.config.ts",
      message: '"./main.ts": is not a normalized path',
    });
  }),
});

const DYNAMIC_IMPORT_REPORT = `{ "diagnostics": [{"message": "import() is banned","code": "sshkeda(no-dynamic-import)","severity": "error","filename": "src/load.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 3,"column": 7}}]}] }`;

const UPSTREAM_HELP_REPORT = `{ "diagnostics": [{"message": "Unexpected any. Specify a different type.","code": "typescript(no-explicit-any)","severity": "error","help": "Use unknown instead.","filename": "src/a.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 1,"column": 1}}]},
{"message": "Unexpected console statement.","code": "eslint(no-console)","severity": "error","help": "Delete this console statement.","filename": "src/a.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 2,"column": 1}}]},
{"message": "Expected === and instead saw ==","code": "eslint(eqeqeq)","severity": "error","help": "Prefer === operator","filename": "src/a.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 3,"column": 1}}]}] }`;

export const upstreamHelpIsNeverPrinted = Task.make({
  name: "oxlint's own help is dropped from every violation, so each prints only its message",
  run: Effect.gen(function* () {
    expect(
      (yield* oxlintReport("oxlint", UPSTREAM_HELP_REPORT)).violations.map(formattedError),
    ).toEqual([
      "src/a.ts:1:1: error typescript(no-explicit-any): Unexpected any. Specify a different type.",
      "src/a.ts:2:1: error eslint(no-console): Unexpected console statement.",
      "src/a.ts:3:1: error eslint(eqeqeq): Expected === and instead saw ==",
    ]);
  }),
});

const UNORDERED_REPORT = `{ "diagnostics": [{"message": "comment in code","code": "sshkeda(no-comments)","severity": "error","filename": "src/b.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 1,"column": 1}}]},
{"message": "Unexpected console statement.","code": "eslint(no-console)","severity": "error","filename": "src/a.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 10,"column": 1}}]},
{"message": "Unexpected any. Specify a different type.","code": "typescript(no-explicit-any)","severity": "error","filename": "src/a.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 2,"column": 9}}]},
{"message": "comment in code","code": "sshkeda(no-comments)","severity": "error","filename": "src/a.ts","labels": [{"span": {"offset": 0,"length": 1,"line": 2,"column": 3}}]}] }`;

export const lintViolationsPrintInFileAndLineOrder = Task.make({
  name: "oxlint lints files on many threads, so its violations print sorted by file, line and column, the same on every run",
  run: Effect.gen(function* () {
    expect(
      (yield* oxlintReport("oxlint", UNORDERED_REPORT)).violations.map(formattedError),
    ).toEqual([
      "src/a.ts:2:3: error sshkeda(no-comments): comment in code",
      "src/a.ts:2:9: error typescript(no-explicit-any): Unexpected any. Specify a different type.",
      "src/a.ts:10:1: error eslint(no-console): Unexpected console statement.",
      "src/b.ts:1:1: error sshkeda(no-comments): comment in code",
    ]);
  }),
});

export const violationsPrintOnlyTheirMessage = Task.make({
  name: "a lint rule or a check violation becomes a printable error with its tag, location and message, and prints one message line",
  run: Effect.gen(function* () {
    const linted = (yield* oxlintReport("oxlint", DYNAMIC_IMPORT_REPORT)).violations;
    expect(linted).toEqual([
      {
        tag: "sshkeda(no-dynamic-import)",
        location: "src/load.ts:3:7",
        message: "import() is banned",
      },
    ]);
    expect(linted.map((violation) => formattedError(violation))).toEqual([
      "src/load.ts:3:7: error sshkeda(no-dynamic-import): import() is banned",
    ]);
    const unused = printableError(new UnusedExport({ location: "src/a.ts:1", exportName: "a" }));
    expect(unused).toEqual({
      tag: "UnusedExport",
      location: "src/a.ts:1",
      message: "export a is used by nothing",
    });
    expect(formattedError(unused)).toBe(
      "src/a.ts:1: error UnusedExport: export a is used by nothing",
    );
  }),
});

export const parentSegmentsAreReportedWithoutClaimingTheyLeave = Task.make({
  name: "a grant path with a .. segment that stays inside the repository is reported as having the segment, not as leaving",
  run: Effect.sync(() => {
    const recorded = recordedGrantsOf({ "src/../main.ts": { allow: ["readsConfig"] } });
    expect(taggedViolations("violations" in recorded ? recorded.violations : [])).toEqual([
      'oxlint.config.ts: error MalformedGrant: "src/../main.ts": has a .. segment',
    ]);
  }),
});

const BUN_CHECK_STANDARD_OUTPUT = `index.ts(2,30): error TS2591: Cannot find name 'node:fs'.
error TS6053: File '/tmp/tcv/nope.ts' not found.
  The file is in the program because:
    Part of 'files' list in tsconfig.json
tsconfig.json(1,40): error TS5023: Unknown compiler option 'bogus'.
`;

export const typeCheckOutputMapsToViolations = Task.make({
  name: "bun check's stdout maps located and location-less diagnostics with their continuation lines, and any other line is TypeCheckLineUnrecognized",
  run: Effect.sync(() => {
    expect(typeCheckReport(BUN_CHECK_STANDARD_OUTPUT, false).violations).toEqual([
      { tag: "TS2591", location: "index.ts:2:30", message: "Cannot find name 'node:fs'." },
      {
        tag: "TS6053",
        message:
          "File '/tmp/tcv/nope.ts' not found.\nThe file is in the program because:\nPart of 'files' list in tsconfig.json",
      },
      {
        tag: "TS5023",
        location: "tsconfig.json:1:40",
        message: "Unknown compiler option 'bogus'.",
      },
    ]);
    expect(
      typeCheckReport(
        "  1  index.ts:2\nindex.ts(2,30): error TS2591: Cannot find name 'node:fs'.\n",
        false,
      ).violations,
    ).toEqual([
      {
        tag: "TypeCheckLineUnrecognized",
        message:
          "type-check printed a line that is not a diagnostic or its continuation:   1  index.ts:2",
      },
      { tag: "TS2591", location: "index.ts:2:30", message: "Cannot find name 'node:fs'." },
    ]);
  }),
});

const OXLINT_SYNTAX_ERROR_REPORT = `{ "diagnostics": [{"message": "Unexpected token","severity": "error","filename": "bad.ts","labels": [{"span": {"offset": 17,"length": 1,"line": 1,"column": 18}}]},
{"message": "Unsafe assignment of an error typed value.","code": "typescript(no-unsafe-assignment)","severity": "error","filename": "bad.ts","labels": [{"label": "Assigned value has type \`error\`.","span": {"offset": 17,"length": 4294967295,"line": null,"column": null}},{"label": "Target is inferred as \`error\`.","span": {"offset": 13,"length": 1,"line": 1,"column": 14}}]},
{"message": "Unused oxlint-disable directive (no problems were reported).","severity": "warning","filename": "bad.ts","labels": [{"span": {"offset": 20,"length": 38,"line": 2,"column": 1}}]}],
  "number_of_files": 1, "number_of_rules": 224, "threads_count": 14, "start_time": 0.2 }`;

export const oxlintReportsMapFieldByField = Task.make({
  name: "an oxlint report with a code-less parse error, a null label line and a warning maps field by field, and a plain-text report is ToolReportUndecodable with its text",
  run: Effect.gen(function* () {
    expect(yield* oxlintReport("oxlint", OXLINT_SYNTAX_ERROR_REPORT)).toEqual({
      violations: [
        {
          tag: "typescript(no-unsafe-assignment)",
          location: "bad.ts:1:14",
          message: "Unsafe assignment of an error typed value.",
        },
        { tag: "oxlint", location: "bad.ts:1:18", message: "Unexpected token" },
      ],
      notes: ["oxlint also reported 1 warning, which this printer cannot show as warnings"],
    });
    const undecodable = yield* oxlintReport(
      "oxlint",
      "error: Cannot use the configuration file oxlint.config.ts:\nFailed to load JS plugin: nope\n",
    ).pipe(failureAsValue);
    expect(undecodable._tag).toBe("ToolReportUndecodable");
    expect(undecodable.message).toContain("Failed to load JS plugin: nope");
    expect(yield* effectViolationsReport("effect-tsgo", "")).toEqual({
      violations: [],
      notes: [],
    });
  }),
});

export const disableDirectivesPrintTheirDirective = Task.make({
  name: "a disable directive becomes a printable error at its line that names the directive",
  run: Effect.sync(() => {
    expect(
      printableError(
        new DisableDirective({ file: "src/cli.ts", line: 4, directive: "@ts-expect-error" }),
      ),
    ).toEqual({
      tag: "DisableDirective",
      location: "src/cli.ts:4",
      message: "has disable directive @ts-expect-error",
    });
  }),
});

const LARGE_OUTPUT_DIAGNOSTICS = 50_000;

export const largeTypeCheckOutputIsReadInOnePass = Task.make({
  name: "100,000 lines of bun check output, each diagnostic followed by a continuation line, become one violation per diagnostic",
  run: Effect.sync(() => {
    const output = Array.from(
      { length: LARGE_OUTPUT_DIAGNOSTICS },
      (_entry, index) =>
        `src/file-${index}.ts(1,1): error TS2322: Type mismatch.\n  continued detail`,
    ).join("\n");
    const { violations } = typeCheckReport(output, false);
    expect(violations.length).toBe(LARGE_OUTPUT_DIAGNOSTICS);
    expect(violations.at(-1)?.message).toBe("Type mismatch.\ncontinued detail");
  }),
});
