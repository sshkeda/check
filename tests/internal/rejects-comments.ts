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
      "/// @ts-nocheck\nlog();",
      "// @TS-NOCHECK\nlog();",
      "/// @ts-ignore\nlog();",
      "/** @ts-expect-error */\nlog();",
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
      "// @ts-nocheck",
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

export const directivesTaskFindsEveryTypeScriptDirectiveFormTscHonors = Task.make({
  name: "the directives task reports @ts-nocheck after three slashes, in any case or before a period or a non-ASCII letter, and @ts-ignore and @ts-expect-error after more than two slashes or in a one-line JSDoc comment, as tsc honors each",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    yield* fileSystem.writeFileString(
      file,
      [
        "/// @ts-nocheck",
        "///@ts-nocheck",
        "// @TS-NOCHECK",
        "/// @ts-nocheck. Generated file.",
        "// @ts-nocheck\u212A",
        "/// @ts-ignore",
        "//// @ts-ignore",
        "/** @ts-ignore */",
        "/// @ts-expect-error",
        "/** @ts-expect-error */",
        "export const answer = 42;",
      ].join("\n"),
    );
    const violations = yield* disableDirectivesIn(file);
    expect(taggedViolations(violations)).toEqual([
      `${file}:1: error DisableDirective: has disable directive @ts-nocheck`,
      `${file}:2: error DisableDirective: has disable directive @ts-nocheck`,
      `${file}:3: error DisableDirective: has disable directive @TS-NOCHECK`,
      `${file}:4: error DisableDirective: has disable directive @ts-nocheck. Generated file.`,
      `${file}:5: error DisableDirective: has disable directive @ts-nocheck\u212A`,
      `${file}:6: error DisableDirective: has disable directive @ts-ignore`,
      `${file}:7: error DisableDirective: has disable directive @ts-ignore`,
      `${file}:8: error DisableDirective: has disable directive * @ts-ignore`,
      `${file}:9: error DisableDirective: has disable directive @ts-expect-error`,
      `${file}:10: error DisableDirective: has disable directive * @ts-expect-error`,
    ]);
  }).pipe(Effect.scoped),
});

export const directivesTaskLeavesLookalikesTscIgnores = Task.make({
  name: "the directives task leaves a comment that looks like a TypeScript suppression but that tsc ignores to no-comments",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    yield* fileSystem.writeFileString(
      file,
      [
        "// * @ts-expect-error",
        "// / @ts-ignore",
        "//\u00A0@ts-ignore",
        "//\u00A0@TS-NOCHECK.",
        "// @TS-IGNORE",
        "// @ts-nocheck-free",
        "/* @ts-nocheck */",
        "/* a note @ts-ignore */",
        "/* @ts-ignore",
        " * a note */",
        "export const answer = 42;",
      ].join("\n"),
    );
    expect(yield* disableDirectivesIn(file)).toEqual([]);
  }).pipe(Effect.scoped),
});

export const directivesTaskFindsTsNoCheckOnlyBeforeTheFirstToken = Task.make({
  name: "the directives task reports @ts-nocheck only before the first token of a file, after a shebang or other comments, and leaves one after code to no-comments, as tsc reads it only there",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    yield* fileSystem.writeFileString(
      file,
      [
        "#!/usr/bin/env bun",
        "/* a header */",
        "",
        "// @ts-nocheck",
        "export const first = 1;",
        "// @ts-nocheck",
        "export const answer = 42; // @ts-nocheck",
      ].join("\n"),
    );
    const violations = yield* disableDirectivesIn(file);
    expect(taggedViolations(violations)).toEqual([
      `${file}:4: error DisableDirective: has disable directive @ts-nocheck`,
    ]);
  }).pipe(Effect.scoped),
});

export const directivesTaskReadsANextLineCharacterAsWhitespace = Task.make({
  name: "the directives task reports a directive after U+0085, which oxlint and tsc read as whitespace",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "main.ts");
    yield* fileSystem.writeFileString(
      file,
      [
        "/*\u0085oxlint-disable sshkeda/no-comments */",
        "\u0085// @ts-nocheck",
        "export const answer = 42;",
      ].join("\n"),
    );
    const violations = yield* disableDirectivesIn(file);
    expect(taggedViolations(violations).map((violation) => violation.split(": error ")[0])).toEqual(
      [`${file}:1`, `${file}:2`],
    );
  }).pipe(Effect.scoped),
});

export const noCommentsReportsTsNoCheckAfterCode = Task.make({
  name: "no-comments reports a @ts-nocheck after the first token as an ordinary comment and leaves one after a shebang to the directives task",
  run: ruleTest("no-comments", {
    valid: ["#!/usr/bin/env bun\n// @ts-nocheck\nlog();"],
    invalid: [
      {
        code: "export const first = 1;\n// @ts-nocheck\nlog();",
        errors: [{ messageId: "comment" }],
      },
    ],
  }),
});

export const directivesTaskCountsEveryLineBreakTscCounts = Task.make({
  name: "the directives task reports the right line in a file whose lines end with CR, CRLF or U+2028, as tsc counts them",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const lines = [
      "export const first = 1;",
      "/* note",
      " * @ts-ignore */",
      "export const second = 2;",
      "// @ts-expect-error",
      "export const third = 3;",
    ];
    const lineBreaks = { cr: "\r", crlf: "\r\n", separator: "\u2028" };
    const linesOfEachFile = yield* Effect.forEach(Object.entries(lineBreaks), ([name, lineBreak]) =>
      Effect.gen(function* () {
        const file = path.join(directory, `${name}.ts`);
        yield* fileSystem.writeFileString(file, lines.join(lineBreak));
        const violations = yield* disableDirectivesIn(file);
        return taggedViolations(violations).map(
          (violation) => violation.split(": error ")[0]?.replace(`${directory}/`, "") ?? "",
        );
      }),
    );
    expect(linesOfEachFile).toEqual([
      ["cr.ts:2", "cr.ts:5"],
      ["crlf.ts:2", "crlf.ts:5"],
      ["separator.ts:2", "separator.ts:5"],
    ]);
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
