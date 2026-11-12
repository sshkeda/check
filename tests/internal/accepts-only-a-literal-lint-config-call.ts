import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Array as Arrays, flow } from "effect";

import { lintConfig } from "../../src/index.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import {
  lintConfigOf,
  loadedLintConfigIn,
} from "../../src/lib/tasks/shared/load-the-lint-config.ts";
import {
  LINT_CONFIG,
  parsedConfigFile,
} from "../../src/lib/tasks/shared/parse-config-files-that-import-from-check.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const IMPORT = 'import { lintConfig } from "@sshkeda/check";\n';

const literalFormViolations = (text: string) => {
  const parsed = lintConfigOf(parsedConfigFile(LINT_CONFIG, LINT_CONFIG.file, text));
  return "violations" in parsed ? taggedViolations(parsed.violations) : [];
};

const wrapperViolations = (exported: string) => literalFormViolations(`${IMPORT}${exported}\n`);

const loadedFrom = (configText: string) =>
  Effect.gen(function* () {
    const { directory } = yield* makeProject({ "main.ts": "export const MAIN = 1;\n" }, configText);
    return yield* loadedLintConfigIn(directory).pipe(
      Effect.map((grants) => ({ grants, violations: new Array<string>() })),
      Effect.catchTag("LintConfigRefused", (refused) =>
        Effect.succeed({ grants: [], violations: taggedViolations(refused.violations) }),
      ),
    );
  }).pipe(Effect.scoped);

const loadedFromFiles = (
  sources: Readonly<Record<string, string>>,
  projectFields: Parameters<typeof makeProject>[2] = {},
) =>
  Effect.gen(function* () {
    const { directory } = yield* makeProject(sources, "lintConfig({})", projectFields);
    return yield* loadedLintConfigIn(directory).pipe(
      Effect.map(() => new Array<string>()),
      Effect.catchTag("LintConfigRefused", (refused) =>
        Effect.succeed(taggedViolations(refused.violations)),
      ),
    );
  }).pipe(Effect.scoped);

const LINE_AFTER_IMPORT = 2;
const LINE_AFTER_EXPORT = 3;

const holdsOtherStatement = (line: number) =>
  `oxlint.config.ts:${line}: error ConfigFileHoldsOtherStatement: holds a statement other than import { lintConfig } from "@sshkeda/check" and export default lintConfig({ ... })`;

const MISSING_IMPORT =
  'oxlint.config.ts: error ConfigFileMissingImport: has no import { lintConfig } from "@sshkeda/check"';

const LOCAL_WRAPPER = [
  'import { lintConfig as strictLintConfig } from "@sshkeda/check";',
  "const lintConfig = (grants: Parameters<typeof strictLintConfig>[0]) => {",
  "  const strict = strictLintConfig(grants);",
  '  return { ...strict, rules: { ...strict.rules, "sshkeda/no-let": "off" } };',
  "};",
  "export default lintConfig({});",
  "",
].join("\n");

export const configFileHoldsOnlyTheImportAndTheExport = Task.make({
  name: "a local lintConfig wrapper that turns a rule off, any statement besides the import and the export, and an import of lintConfig that is renamed, a namespace or type-only are refused at their lines, and a file that only lacks the import is refused once",
  run: Effect.sync(() => {
    expect(literalFormViolations(LOCAL_WRAPPER)).toEqual([
      holdsOtherStatement(1),
      holdsOtherStatement(LINE_AFTER_IMPORT),
    ]);
    expect(literalFormViolations("export default lintConfig({});\n")).toEqual([MISSING_IMPORT]);
    expect(wrapperViolations('export default lintConfig({});\nconsole.log("loaded");')).toEqual([
      holdsOtherStatement(LINE_AFTER_EXPORT),
    ]);
    for (const otherImport of [
      'import { lintConfig as config } from "@sshkeda/check";',
      'import * as check from "@sshkeda/check";',
      'import type { lintConfig } from "@sshkeda/check";',
      'import lintConfig from "@sshkeda/check";',
    ]) {
      expect(literalFormViolations(`${otherImport}\nexport default lintConfig({});\n`)).toEqual([
        holdsOtherStatement(1),
      ]);
    }
  }),
});

export const lintConfigImportedFromOutsideCheckIsRefused = Task.make({
  name: "lintConfig imported from a local file, or from @sshkeda/check that tsconfig paths maps to a local file, is refused, naming the file it resolves to",
  run: Effect.gen(function* () {
    const looseLintConfig =
      'import { lintConfig as strictLintConfig } from "@sshkeda/check";\nexport const lintConfig = strictLintConfig;\n';
    expect(
      yield* loadedFromFiles({
        "loose-lint-config.ts": looseLintConfig,
        "oxlint.config.ts":
          'import { lintConfig } from "./loose-lint-config.ts";\n\nexport default lintConfig({});\n',
      }),
    ).toEqual([
      "oxlint.config.ts:1: error ConfigFileImportsFromOutsideCheck: imports lintConfig from ./loose-lint-config.ts, which resolves to loose-lint-config.ts instead of a file of @sshkeda/check",
    ]);
    expect(
      yield* loadedFromFiles(
        { "loose-lint-config.ts": looseLintConfig },
        {
          compilerOptions: {
            strict: true,
            module: "Preserve",
            moduleResolution: "Bundler",
            allowImportingTsExtensions: true,
            noEmit: true,
            paths: { "@sshkeda/check": ["./loose-lint-config.ts"] },
          },
        },
      ),
    ).toEqual([
      "oxlint.config.ts:1: error ConfigFileImportsFromOutsideCheck: imports lintConfig from @sshkeda/check, which resolves to loose-lint-config.ts instead of a file of @sshkeda/check",
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

const LOOSE_LINT_CONFIG =
  'import { lintConfig as strictLintConfig } from "@sshkeda/check";\nexport const lintConfig = strictLintConfig;\n';

const importsFromOutsideCheck = (request: string, resolvedFile: string) =>
  `oxlint.config.ts:1: error ConfigFileImportsFromOutsideCheck: imports lintConfig from ${request}, which resolves to ${resolvedFile} instead of a file of @sshkeda/check`;

export const lintConfigFromAnImportsEntryWithATypesConditionIsRefused = Task.make({
  name: "lintConfig imported through a package.json imports entry whose types condition points at @sshkeda/check while Bun loads a local file is refused, since Bun resolves without the types condition",
  run: Effect.gen(function* () {
    expect(
      yield* loadedFromFiles({
        "package.json": yield* encodeJson({
          name: "checked",
          type: "module",
          imports: { "#check": { types: "@sshkeda/check", default: "./loose-lint-config.ts" } },
        }),
        "loose-lint-config.ts": LOOSE_LINT_CONFIG,
        "oxlint.config.ts":
          'import { lintConfig } from "#check";\n\nexport default lintConfig({});\n',
      }),
    ).toEqual([importsFromOutsideCheck("#check", "loose-lint-config.ts")]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const lintConfigFromANestedPackageNamedCheckIsRefused = Task.make({
  name: "lintConfig imported from a nested package named @sshkeda/check is refused, since it is neither an installed package nor the project itself",
  run: Effect.gen(function* () {
    expect(
      yield* loadedFromFiles({
        "src/vendored/package.json": yield* encodeJson({ name: "@sshkeda/check", type: "module" }),
        "src/vendored/index.ts": LOOSE_LINT_CONFIG,
        "oxlint.config.ts":
          'import { lintConfig } from "./src/vendored/index.ts";\n\nexport default lintConfig({});\n',
      }),
    ).toEqual([importsFromOutsideCheck("./src/vendored/index.ts", "src/vendored/index.ts")]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const literalLintConfigCallLoadsItsGrants = Task.make({
  name: "a literal lintConfig() call with quoted and bare keys loads every grant and boundary",
  run: Effect.gen(function* () {
    expect(
      yield* loadedFrom(
        'lintConfig({ "main.ts": { allow: ["usesSqlDatabases"], services: ["Store"] }, src: { cannotImport: ["main.ts"] }, "port.ts": { allow: ["usesSqlDatabases", "trustsUnverifiedTypes"] } })',
      ),
    ).toEqual({
      violations: [],
      grants: [
        { path: "main.ts", allow: ["usesSqlDatabases"], services: ["Store"], cannotImport: [] },
        { path: "src", allow: [], services: [], cannotImport: ["main.ts"] },
        {
          path: "port.ts",
          allow: ["usesSqlDatabases", "trustsUnverifiedTypes"],
          services: [],
          cannotImport: [],
        },
      ],
    });
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

const repeated = (key: string) =>
  `oxlint.config.ts:2: error LintConfigKeyRepeated: names ${key} more than once in one object passed to lintConfig()`;

export const repeatedKeysInLintConfigAreRefused = Task.make({
  name: "a key named twice in one object passed to lintConfig(), a grant or the path map, is refused at the line that names it again instead of the last one winning",
  run: Effect.sync(() => {
    expect(
      literalFormViolations(
        `${IMPORT}export default lintConfig({ "a.ts": { allow: ["usesSqlDatabases"], allow: [] }, "a.ts": {} });\n`,
      ),
    ).toEqual([repeated("a.ts"), repeated("allow")]);
    expect(
      literalFormViolations(
        `${IMPORT}\nexport default lintConfig({\n  "a.ts": { allow: ["usesSqlDatabases"] },\n  "b.ts": { allow: ["usesSqlDatabases"] },\n  "a.ts": { allow: ["trustsUnverifiedTypes"] },\n});\n`,
      ),
    ).toEqual([
      "oxlint.config.ts:6: error LintConfigKeyRepeated: names a.ts more than once in one object passed to lintConfig()",
    ]);
  }),
});

export const wrappersAroundCheckAreRefused = Task.make({
  name: "defineConfig, extends, a hand-written override (one turning a module ban off included), satisfies, a second argument or a renamed call around lintConfig() are refused",
  run: Effect.sync(() => {
    const exportsSomethingElse =
      "oxlint.config.ts:2: error ConfigFileExportsSomethingElse: exports something other than lintConfig({ ... })";
    expect(wrapperViolations("export default defineConfig(lintConfig({}));")).toEqual([
      exportsSomethingElse,
    ]);
    expect(
      wrapperViolations("export default { extends: [lintConfig({})], overrides: [] };"),
    ).toEqual([exportsSomethingElse]);
    expect(
      wrapperViolations(
        'export default defineConfig({ ...lintConfig({}), overrides: [{ files: ["./src/load.ts"], rules: { "sshkeda/no-node-file-system": "off" } }] });',
      ),
    ).toEqual([exportsSomethingElse]);
    expect(wrapperViolations("export default lintConfig({}) satisfies object;")).toEqual([
      exportsSomethingElse,
    ]);
    expect(wrapperViolations("export default lintConfig({}, {});")).toEqual([exportsSomethingElse]);
    expect(wrapperViolations("export default lint({});")).toEqual([exportsSomethingElse]);
  }),
});

export const nonLiteralEntriesAreRefused = Task.make({
  name: "spreads, computed keys, variables, methods and template strings inside lintConfig() are refused",
  run: Effect.sync(() => {
    const passesNonLiterals =
      "oxlint.config.ts:2: error LintConfigArgumentNotLiteral: passes lintConfig() something other than literals";
    for (const argument of [
      "shared",
      "{ ...shared }",
      '{ [name]: { allow: ["usesSqlDatabases"] } }',
      '{ "a.ts": grant }',
      '{ "a.ts": { ...grant } }',
      '{ "a.ts": { allow: permissions } }',
      '{ "a.ts": { allow: [...permissions] } }',
      '{ "a.ts": { allow: [permission] } }',
      '{ "a.ts": { allow: [`usesSqlDatabases`] } }',
      '{ "a.ts": { allow() { return ["usesSqlDatabases"]; } } }',
      "{ src }",
    ]) {
      expect(literalFormViolations(`${IMPORT}export default lintConfig(${argument});\n`)).toEqual([
        passesNonLiterals,
      ]);
    }
  }),
});

export const configsWithoutADefaultLintConfigCallAreRefused = Task.make({
  name: "a config bound to a variable, a config without export default or a file that does not parse is refused",
  run: Effect.sync(() => {
    expect(
      literalFormViolations(`${IMPORT}const config = lintConfig({});\nexport default config;\n`),
    ).toEqual([
      "oxlint.config.ts:3: error ConfigFileExportsSomethingElse: exports something other than lintConfig({ ... })",
      holdsOtherStatement(LINE_AFTER_IMPORT),
    ]);
    expect(literalFormViolations(`${IMPORT}export const CONFIG = lintConfig({});\n`)).toEqual([
      "oxlint.config.ts: error ConfigFileMissingDefaultExport: has no export default lintConfig({ ... })",
      holdsOtherStatement(LINE_AFTER_IMPORT),
    ]);
    expect(literalFormViolations("export default {")[0]).toStartWith(
      "oxlint.config.ts: error ConfigFileUnparsable: does not parse: ",
    );
  }),
});

export const refusedGrantsAreReportedFromTheParsedLiteral = Task.make({
  name: "grants read from the parsed literal are validated by the same function lintConfig() uses, and a whole route parameter segment such as [slug] is a literal path, not a glob",
  run: Effect.gen(function* () {
    expect(
      yield* loadedFrom('lintConfig({ "src/*.ts": { allow: ["usesSqlDatabases"] } })'),
    ).toEqual({
      grants: [],
      violations: ['oxlint.config.ts: error MalformedGrant: "src/*.ts": is a glob'],
    });
    expect(() => lintConfig({ "src/*.ts": { allow: ["usesSqlDatabases"] } })).toThrow(
      /^oxlint\.config\.ts: error MalformedGrant: "src\/\*\.ts": is a glob$/u,
    );
    expect(() =>
      lintConfig({ "app/blog/[slug]/[[...rest]]/page.tsx": { allow: ["writesToTheTerminal"] } }),
    ).not.toThrow();
    expect(() => lintConfig({ "app/[a-z]*.tsx": { allow: ["writesToTheTerminal"] } })).toThrow(
      /MalformedGrant: "app\/\[a-z\]\*\.tsx": is a glob/u,
    );
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const configNeverLintsNodeModules = Task.make({
  name: "lintConfig ignores node_modules, so a plain oxlint run never walks into a symlinked workspace package",
  run: Effect.sync(() => {
    expect(lintConfig({}).ignorePatterns).toContain("**/node_modules/**");
  }),
});
