import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Duration, Effect, FileSystem, Path, Array as Arrays, flow } from "effect";

import { disableDirectivesIn } from "../../src/lib/tasks/lib/refuse-disable-directives/internal/find-disable-directives.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const EFFECT_DIRECTIVE = "@effect-diagnostics-next-line";

const DIRECTIVES_IN_A_LARGE_FILE = 25_000;

const MOST_MILLISECONDS_TO_SCAN_A_LARGE_FILE = 5000;

const LINES_PER_DIRECTIVE = 2;

const OVERRIDE = (comment: string) => `export default defineConfig({
  overrides: [
    ${comment}
    { files: ["src/main.ts"], rules: { "eslint/no-console": "error" } },
  ],
});`;

export const rejectsCodeComments = Task.make({
  name: "no-comments flags every comment in code",
  run: ruleTest("no-comments", {
    valid: ["const answer = 42;", "#!/usr/bin/env bun\nconst answer = 42;"],
    invalid: [
      { code: "// the answer\nconst answer = 42;", errors: [{ messageId: "comment" }] },
      { code: "const answer = 42; /* the answer */", errors: [{ messageId: "comment" }] },
      { code: "/** The answer. */\nconst answer = 42;", errors: [{ messageId: "comment" }] },
      {
        code: '/// <reference types="bun" />\nconst answer = 42;',
        errors: [{ messageId: "comment" }],
      },
      {
        code: "// a\n// b\nconst answer = 42;",
        errors: [{ messageId: "comment" }, { messageId: "comment" }],
      },
    ],
  }),
});

export const rejectsTheCommentAboveAnOverride = Task.make({
  name: "no-comments flags the comment above an override entry like any other comment",
  run: ruleTest("no-comments", {
    valid: [],
    invalid: [
      {
        code: `export default defineConfig({
  overrides: [
    // main.ts is the entry point, so it sets the exit code.
    { files: ["src/main.ts"], rules: { "unicorn/no-process-exit": "off" } },
  ],
});`,
        filename: "src/lint-settings.ts",
        errors: [{ messageId: "comment" }],
      },
      ...[
        OVERRIDE("//"),
        `export default defineConfig({
  // the config
  overrides: [{ files: ["src/main.ts"], rules: {} }],
});`,
        `export default defineConfig({
  overrides: [{ files: ["src/main.ts"], rules: { /* why */ "eslint/no-console": "error" } }],
});`,
        `export default someOtherCall({
  overrides: [
    // main.ts sets the exit code.
    { files: ["src/main.ts"], rules: {} },
  ],
});`,
      ].map((code) => ({ code, errors: [{ messageId: "comment" }] })),
    ],
  }),
});

export const leavesDisableDirectivesToTheDirectivesTask = Task.make({
  name: "no-comments leaves every disable directive, explained or not, to the directives task, which a directive cannot switch off",
  run: ruleTest("no-comments", {
    valid: [
      "// oxlint-disable-next-line typescript/consistent-type-assertions -- the value is JSON the runner checked\nconst answer = value as Answer;",
      "// oxlint-disable-next-line no-console\nlog();",
      "/* oxlint-disable-next-line no-console -- logging is the point */\nlog();",
      "// oxlint-disable no-console -- logging is the point\nlog();",
      "// oxlint-enable no-console\nlog();",
      "/* eslint-disable */\nlog();",
      "// eslint-disable-next-line no-console\nlog();",
      "// @ts-ignore\nlog();",
      "// @ts-expect-error\nlog();",
      "// @ts-nocheck\nlog();",
      "/*\n * @ts-ignore */\nlog();",
      `// ${EFFECT_DIRECTIVE} floatingEffect:off\nlog();`,
      "// @effect-diagnostics floatingEffect:off\nlog();",
    ],
    invalid: [],
  }),
});

export const directivesTaskFindsEveryDisableDirective = Task.make({
  name: "the directives task reports explained disables, TypeScript suppressions and Effect suppressions",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    const directives = [
      "// oxlint-disable-next-line node/no-sync -- writes must reach stderr in order",
      "// @ts-expect-error",
      "// @ts-ignore",
      "/* @ts-nocheck */",
      `// ${EFFECT_DIRECTIVE} floatingEffect:off`,
      "// eslint-disable-line",
    ];
    yield* fileSystem.writeFileString(
      file,
      [...directives, "// an ordinary comment", "export const answer = 42;"].join("\n"),
    );
    const violations = yield* disableDirectivesIn(file);
    expect(taggedViolations(violations).map((violation) => violation.split(": error ")[0])).toEqual(
      directives.map((_directive, index) => `${file}:${index + 1}`),
    );
  }).pipe(Effect.scoped),
});

export const directivesTaskCountsLinesOncePerFile = Task.make({
  name: "the directives task reports the line of each of 25,000 directives in a 50,000-line file in under 5 seconds",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    yield* fileSystem.writeFileString(
      file,
      Array.from(
        { length: DIRECTIVES_IN_A_LARGE_FILE },
        (_directive, index) =>
          `// oxlint-disable-next-line no-console\nexport const VALUE_${index} = ${index};\n`,
      ).join(""),
    );
    const [elapsed, violations] = yield* Effect.timed(disableDirectivesIn(file));
    expect(taggedViolations(violations).map((violation) => violation.split(": error ")[0])).toEqual(
      Array.from(
        { length: DIRECTIVES_IN_A_LARGE_FILE },
        (_directive, index) => `${file}:${index * LINES_PER_DIRECTIVE + 1}`,
      ),
    );
    expect(Duration.toMillis(elapsed)).toBeLessThan(MOST_MILLISECONDS_TO_SCAN_A_LARGE_FILE);
  }).pipe(Effect.scoped),
});

export const directivesTaskFindsSuppressionsInsideBlockComments = Task.make({
  name: "the directives task finds a TypeScript suppression on the last line of a block comment, where TypeScript reads one too, and reports the line the comment starts on",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    yield* fileSystem.writeFileString(
      file,
      [
        "/*",
        " * @ts-ignore */",
        "log();",
        "/**",
        " * explained",
        " * @ts-expect-error */",
        "log();",
        "/* an ordinary comment that names",
        "   @ts-ignore on a line before its last",
        "   one */",
        "export const answer = 42;",
      ].join("\n"),
    );
    const violations = yield* disableDirectivesIn(file);
    expect(taggedViolations(violations).map((violation) => violation.split(": error ")[0])).toEqual(
      [`${file}:1`, `${file}:4`],
    );
  }).pipe(Effect.scoped),
});

export const directivesTaskReportsTheLineThatDoesNotParse = Task.make({
  name: "the directives task reports a file that does not parse at the line of each parse error",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    yield* fileSystem.writeFileString(
      file,
      ['export const GREETING = "hello";', "", "export const FAREWELL = ;", ""].join("\n"),
    );
    const violations = yield* disableDirectivesIn(file);
    expect(taggedViolations(violations)).toEqual([
      `${file}:3: error SourceFileUnparsable: does not parse: Unexpected token`,
    ]);
  }).pipe(Effect.scoped),
});
