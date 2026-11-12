import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Array as Arrays, flow } from "effect";

import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import { findFileLayoutViolations } from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { oxlintBinary } from "../shared/oxlint-binary.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const reportsOf = (sources: Readonly<Record<string, string>>, lintConfig = "lintConfig({})") =>
  Effect.gen(function* () {
    const { directory, tsconfigFile } = yield* makeProject(
      { ".gitignore": "node_modules\n", ...sources },
      lintConfig,
    );
    const lintReports = yield* Task.exec(
      "bun",
      [
        yield* oxlintBinary,
        "--config",
        "oxlint.config.ts",
        "--format",
        "unix",
        "--",
        ...Object.keys(sources),
      ],
      { cwd: directory },
    ).pipe(
      Effect.as(""),
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    const boundaryReports = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    const layoutReports = yield* findFileLayoutViolations(directory).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("FileLayoutViolations", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    return [
      ...lintReports.split("\n").filter((line) => line.includes(": ")),
      ...boundaryReports,
      ...layoutReports,
    ];
  }).pipe(Effect.scoped);

const FOR_STATEMENT_LINE = 2;
const CREATED_REQUIRE_CALL_LINE = 3;
const REQUIRE_NAMED_CALL_LINE = 4;

const reportsAtLine = (reports: readonly string[], file: string, line: number) =>
  reports.filter((report) => report.startsWith(`${file}:${line}:`));

const reportsTagged = (reports: readonly string[], tags: readonly string[]) =>
  reports.filter((report) => tags.some((tag) => report.includes(` ${tag}`))).toSorted();

export const forStatementStartingWithLetIsNoWhileAlone = Task.make({
  name: "no-let skips the let that starts a for statement, so that for statement is no-while alone",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({
      "main.ts": [
        "export const first = (items: ReadonlyArray<number>) => {",
        "  for (let index = 0; index < items.length; index += 1) {",
        "    return index;",
        "  }",
        "  return 0;",
        "};",
        "",
      ].join("\n"),
    });
    expect(reportsAtLine(reports, "main.ts", FOR_STATEMENT_LINE)).toEqual([
      "main.ts:2:3: for loops on a condition or counter that outside state must change [Error/sshkeda(no-while)]",
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

const MISSING_FILE_IMPORT =
  "ImportResolvesToNoFile: imports ./missing.ts, which resolves to no file";
const REQUIRE_CALL = 'Expected "import" statement instead of "require" call';

const requireCall = (file: string, line: number, column: number) =>
  `${file}:${line}:${column}: ${REQUIRE_CALL} [Error/typescript(no-require-imports)]`;

const missingFileImport = (file: string, line: number) =>
  `${file}:${line}: error ${MISSING_FILE_IMPORT}`;

export const requireOfAMissingFileIsReportedOnce = Task.make({
  name: "require() of a missing file is reported once: the global require and import = require as typescript/no-require-imports alone, also in a .js file outside the TypeScript project, and a createRequire function, also one named require, as ImportResolvesToNoFile alone",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({
      "src/global.ts": 'require("./missing.ts");\n',
      "src/import-equals.ts":
        'import missing = require("./missing.ts");\nexport const LOADED = missing;\n',
      "src/global-outside-project.js": 'require("./missing.ts");\n',
      "src/created.ts": [
        'import { createRequire } from "node:module";',
        "const load = createRequire(import.meta.url);",
        'export const LOADED = load("./missing.ts");',
        "",
      ].join("\n"),
      "src/created-as-require.ts": [
        'import { createRequire } from "node:module";',
        "export const load = () => {",
        "  const require = createRequire(import.meta.url);",
        '  return require("./missing.ts");',
        "};",
        "",
      ].join("\n"),
    });
    expect(
      reports
        .filter(
          (report) =>
            report.includes("no-require-imports") || report.includes("ImportResolvesToNoFile"),
        )
        .toSorted(),
    ).toEqual(
      [
        requireCall("src/global.ts", 1, 1),
        requireCall("src/import-equals.ts", 1, 1),
        requireCall("src/global-outside-project.js", 1, 1),
        missingFileImport("src/created.ts", CREATED_REQUIRE_CALL_LINE),
        missingFileImport("src/created-as-require.ts", REQUIRE_NAMED_CALL_LINE),
      ].toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

const TEST_IMPORT_TAGS = ["CannotImportCrossed", "TestImported"] as const;
const SAMPLE_TEST = { "tests/sample.ts": "export const SAMPLE = 1;\n" } as const;

export const sourceImportingATestIsReportedOnce = Task.make({
  name: "src importing a test in any form is reported once as TestImported",
  run: Effect.gen(function* () {
    const sources = {
      "src/static.ts":
        'import { SAMPLE } from "../tests/sample.ts";\nexport const USED = SAMPLE;\n',
      "src/dynamic.ts": 'export const LOADED = import("../tests/sample.ts");\n',
      "src/type-only.ts":
        'import type { SAMPLE } from "../tests/sample.ts";\nexport const USED: typeof SAMPLE = 1;\n',
      "src/re-export.ts": 'export { SAMPLE } from "../tests/sample.ts";\n',
      "src/required.ts": 'export const LOADED = require("../tests/sample.ts");\n',
    } as const;
    const reports = yield* reportsOf({ ...sources, ...SAMPLE_TEST });
    expect(reportsTagged(reports, TEST_IMPORT_TAGS)).toEqual(
      Object.keys(sources)
        .map(
          (file) =>
            `${file}:1: error TestImported: imports tests/sample.ts, but only scripts/ and tests/ may import tests/`,
        )
        .toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const testImportCrossingAUserBanIsAlsoTestImported = Task.make({
  name: "a test import crossing an explicit user ban reports both the user ban and the test boundary",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf(
      {
        "lib2/user-ban.ts":
          'import { SAMPLE } from "../tests/sample.ts";\nexport const USED = SAMPLE;\n',
        ...SAMPLE_TEST,
      },
      'lintConfig({ "lib2": { cannotImport: ["tests"] } })',
    );
    expect(reportsTagged(reports, TEST_IMPORT_TAGS)).toEqual(
      [
        "lib2/user-ban.ts:1: error CannotImportCrossed: imports tests/sample.ts, and lib2 cannot import tests",
        "lib2/user-ban.ts:1: error TestImported: imports tests/sample.ts, but only scripts/ and tests/ may import tests/",
      ].toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

const NAME_TAGS = [
  "NotKebabCase",
  "TopLevelNonScript",
  "BunTestFileName",
  "MisplacedAtPackageRoot",
] as const;

export const nonScriptPlacementIsReportedOnce = Task.make({
  name: "a non-script directly in scripts/ has one placement error, while an uppercase extension has a separate naming error",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({
      "scripts/deploy.sh": "echo deploy\n",
      "scripts/release.SH": "echo release\n",
      "scripts/build.bash": "echo build\n",
      "scripts/report.py": "print(1)\n",
      "scripts/bundle.TS": "export {};\n",
      "scripts/notes.txt": "notes\n",
    });
    expect(reportsTagged(reports, NAME_TAGS)).toEqual(
      [
        "scripts/deploy.sh: error TopLevelNonScript: sits directly in scripts/ and is not a TypeScript or JavaScript file",
        "scripts/release.SH: error NotKebabCase: release.SH is not kebab-case",
        "scripts/release.SH: error TopLevelNonScript: sits directly in scripts/ and is not a TypeScript or JavaScript file",
        "scripts/build.bash: error TopLevelNonScript: sits directly in scripts/ and is not a TypeScript or JavaScript file",
        "scripts/report.py: error TopLevelNonScript: sits directly in scripts/ and is not a TypeScript or JavaScript file",
        "scripts/bundle.TS: error NotKebabCase: bundle.TS is not kebab-case",
        "scripts/notes.txt: error TopLevelNonScript: sits directly in scripts/ and is not a TypeScript or JavaScript file",
      ].toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const foreignSourceNamingIsCheckedIndependently = Task.make({
  name: "foreign source files follow the same kebab-case rules as every other file",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({
      "src/probes/upper.SH": "echo upper\n",
      "src/probes/lower.sh": "echo lower\n",
      "src/probes/mixed.Py": "print(1)\n",
      "src/Foo.SH": "echo foo\n",
      "src/Tools/inner.BASH": "echo inner\n",
    });
    expect(reportsTagged(reports, NAME_TAGS)).toEqual(
      [
        "src/probes/upper.SH: error NotKebabCase: upper.SH is not kebab-case",
        "src/probes/mixed.Py: error NotKebabCase: mixed.Py is not kebab-case",
        "src/Foo.SH: error NotKebabCase: Foo.SH is not kebab-case",
        "src/Tools/inner.BASH: error NotKebabCase: Tools is not kebab-case",
      ].toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const nonMarkdownPlacementInDocsIsReportedOnce = Task.make({
  name: "each non-markdown file in docs/ has one placement error and naming errors stay separate",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({
      "docs/setup.sh": "echo setup\n",
      "docs/report.PY": "print(1)\n",
      "docs/notes.txt": "notes\n",
    });
    expect(reportsTagged(reports, NAME_TAGS)).toEqual(
      [
        "docs/setup.sh: error MisplacedAtPackageRoot: is not markdown but sits in docs/",
        "docs/report.PY: error NotKebabCase: report.PY is not kebab-case",
        "docs/report.PY: error MisplacedAtPackageRoot: is not markdown but sits in docs/",
        "docs/notes.txt: error MisplacedAtPackageRoot: is not markdown but sits in docs/",
      ].toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const bunTestFileNameIsOnlyAFileBunRunsAsATest = Task.make({
  name: "BunTestFileName is a .test or .spec name in any case with a JavaScript or TypeScript extension in any case, so a .test or .spec shell, Python, markdown or .d.ts file is not BunTestFileName, and a _test or _spec name is NotKebabCase alone",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({
      "src/run.test.sh": "echo run\n",
      "src/run.spec.py": "print(1)\n",
      "src/notes.test.md": "# Notes\n",
      "src/types.test.d.ts": "export {};\n",
      "src/run.test.ts": "export {};\n",
      "src/run.spec.mjs": "export {};\n",
      "src/upper.test.TS": "export {};\n",
      "src/capital.Test.ts": "export {};\n",
      "src/upper.SPEC.jsx": "export {};\n",
      "src/under_test.ts": "export {};\n",
      "src/under_spec.js": "export {};\n",
    });
    expect(reportsTagged(reports, ["BunTestFileName", "NotKebabCase"])).toEqual(
      [
        "src/run.test.ts: error BunTestFileName: is named like a bun test",
        "src/run.spec.mjs: error BunTestFileName: is named like a bun test",
        "src/upper.test.TS: error BunTestFileName: is named like a bun test",
        "src/upper.test.TS: error NotKebabCase: upper.test.TS is not kebab-case",
        "src/capital.Test.ts: error BunTestFileName: is named like a bun test",
        "src/capital.Test.ts: error NotKebabCase: capital.Test.ts is not kebab-case",
        "src/upper.SPEC.jsx: error BunTestFileName: is named like a bun test",
        "src/upper.SPEC.jsx: error NotKebabCase: upper.SPEC.jsx is not kebab-case",
        "src/under_test.ts: error NotKebabCase: under_test.ts is not kebab-case",
        "src/under_spec.js: error NotKebabCase: under_spec.js is not kebab-case",
      ].toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

const notKebabCaseReportsOf = (reports: readonly string[]) =>
  reports.filter((report) => report.includes(" NotKebabCase")).toSorted();

const notKebabCase = (directory: string, fileName: string) =>
  `${directory}/${fileName}: error NotKebabCase: ${fileName} is not kebab-case`;

const MISNAMED_SCRIPT_FILE_NAMES = [
  "FooBar.ts",
  "foo copy.ts",
  "Émile.ts",
  "foo--bar.ts",
  "foo.Bar.ts",
  "_foo.ts",
] as const;

export const notKebabCaseReportsEveryMisnamedScriptFile = Task.make({
  name: "NotKebabCase reports every script file name that is not kebab-case, whether or not unicorn/filename-case also reports it",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf(
      Object.fromEntries(
        MISNAMED_SCRIPT_FILE_NAMES.map((fileName) => [
          `src/${fileName}`,
          "export const NAME = 1;\n",
        ]),
      ),
    );
    expect(notKebabCaseReportsOf(reports)).toEqual(
      MISNAMED_SCRIPT_FILE_NAMES.map((fileName) => notKebabCase("src", fileName)).toSorted(),
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const notKebabCaseReportsEveryMisnamedPartAtOnce = Task.make({
  name: "NotKebabCase on a file name names the whole name, so a name misnamed before and after its first dot is reported in full, not one part per rename",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({ "src/Foo.Bar.ts": "export const NAME = 1;\n" });
    expect(notKebabCaseReportsOf(reports)).toEqual([notKebabCase("src", "Foo.Bar.ts")]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const notKebabCaseReportsAFileOxlintCannotParse = Task.make({
  name: "NotKebabCase reports a misnamed script file that has a syntax error, which oxlint does not lint",
  run: Effect.gen(function* () {
    const reports = yield* reportsOf({ "src/HomePage.ts": "export const = ;\n" });
    expect(notKebabCaseReportsOf(reports)).toEqual([notKebabCase("src", "HomePage.ts")]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});
