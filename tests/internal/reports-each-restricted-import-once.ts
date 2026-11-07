import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { RESTRICTED_IMPORT_PATHS } from "../../src/index.ts";
import { EFFECT_TESTING_MODULES } from "../../src/internal/keep-effect-testing-helpers-in-test-files.ts";
import { bansByKind } from "../../src/internal/match-banned-modules-and-globals.ts";
import { oxlintReport } from "../../src/lib/tasks/lib/lint-with-oxlint/internal/read-oxlint-json-report.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  equivalentModuleSpecifiers,
  everyBanOf,
  GRANTABLE_BAN_NAMES,
  MODULE_PATTERN_WILDCARD,
  PERMISSION_BANS,
} from "../../src/shared/bans-each-permission-lifts.ts";
import {
  ASSERTION_MODULES,
  BUN_TEST,
  NODE_BUILTIN_RULES,
  TEST_RUNNER_MODULES,
} from "../../src/shared/lint-rule-messages-and-patterns.ts";
import {
  lintErrorsOfEachCase,
  lintErrorsOfGrantedCases,
} from "../shared/lint-errors-of-each-case.ts";

const NODE_PATH = "sshkeda(no-node-path): importing node:path is banned";
const REQUIRE_IMPORT =
  'typescript(no-require-imports): Expected "import" statement instead of "require" call';
const DYNAMIC_IMPORT = "sshkeda(no-dynamic-import): dynamic import() is banned";
const UNASSIGNED_IMPORT = "import(no-unassigned-import): Imported module should be assigned";
const IMPORT_TYPE_SIDE_EFFECTS =
  "typescript(no-import-type-side-effects): TypeScript will only remove the inline type specifiers which will leave behind a side effect import at runtime.";
const runnerFromBunTest = (imported: string) =>
  `sshkeda(no-test-runners): imports ${imported} from bun:test`;
const RUNNER_MODULE_FROM_BUN_TEST = runnerFromBunTest("a test runner");

const PREFER_NODE_PROTOCOL = "unicorn(prefer-node-protocol)";

const UNUSED_GRANT = /: this file is granted \w+, but uses nothing \w+ allows$/u;

const isAnotherReport = (error: string) =>
  error.startsWith(PREFER_NODE_PROTOCOL) || UNUSED_GRANT.test(error);

const withoutNodeProtocolHintsOrUnusedGrants = (
  linted: readonly { readonly code: string; readonly errors: readonly string[] }[],
) =>
  linted.map(({ code, errors }) => ({
    code,
    errors: errors.filter((error) => !isAnotherReport(error)),
  }));

const reported = (cases: readonly (readonly [string, readonly string[]])[]) =>
  cases.map(([code, errors]) => ({ code, errors: [...errors] }));

const expectEachCaseReports = (
  directory: string,
  cases: readonly (readonly [string, readonly string[]])[],
  allow: readonly string[] = [],
) =>
  Effect.gen(function* () {
    expect(
      withoutNodeProtocolHintsOrUnusedGrants(
        yield* lintErrorsOfEachCase(
          oxlintReport,
          REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          directory,
          cases.map(([code]) => code),
          allow,
        ),
      ),
    ).toEqual(reported(cases));
  });

export const restrictedImportsOutsideTheTestHome = Task.make(
  "outside tests/, each restricted import is reported once, with a message that states only what is imported: Node built-ins Effect replaces, members of Bun that are restricted, assertions, test runners and loads of bun:test that name nothing, with a load that names nothing also reported by import(no-unassigned-import), while import =, import {}, re-exports and import() of a module no rule bans stay with the rule that owns them",
  expectEachCaseReports("src", [
    ['import { join } from "node:path";\n\nexport const USED = [join];', [NODE_PATH]],
    ['import path = require("node:path");\n\nexport const USED = [path.join];', [REQUIRE_IMPORT]],
    [
      'export import path = require("node:path");',
      ["sshkeda(no-re-exports): export import path re-exports another module", REQUIRE_IMPORT],
    ],
    ['export const load = () => import("node:path");', [NODE_PATH]],
    ['import {} from "node:path";', [IMPORT_TYPE_SIDE_EFFECTS]],
    [
      'export { join } from "node:path";',
      ["sshkeda(no-re-exports): export from node:path re-exports another module"],
    ],
    [
      'export * from "node:path";',
      ["sshkeda(no-re-exports): export * from node:path re-exports another module"],
    ],
    ['export const load = () => import("./local.ts");', [DYNAMIC_IMPORT]],
    [
      'import { file } from "bun";\n\nexport const USED = [file];',
      ["eslint(no-restricted-imports): 'file' import from 'bun' is restricted."],
    ],
    [
      'import type { file } from "bun";\n\nexport const read = (reader: typeof file) => reader;',
      [],
    ],
    [
      'import { expect } from "bun:test";\n\nexport const USED = [expect];',
      ["sshkeda(no-assertions): asserts with expect from bun:test outside tests/"],
    ],
    [
      'import assert from "node:assert/strict";\n\nexport const USED = [assert];',
      ["sshkeda(no-assertions): asserts with node:assert/strict outside tests/"],
    ],
    [
      'import { describe } from "bun:test";\n\nexport const USED = [describe];',
      [runnerFromBunTest("describe")],
    ],
    [
      'import * as runner from "bun:test";\n\nexport const USED = [runner.describe];',
      [runnerFromBunTest("runner")],
    ],
    [
      'export * from "bun:test";',
      ["sshkeda(no-re-exports): export * from bun:test re-exports another module"],
    ],
    [
      'import runner = require("bun:test");\n\nexport const USED = [runner.describe];',
      [REQUIRE_IMPORT],
    ],
    ['import "bun:test";', [UNASSIGNED_IMPORT, RUNNER_MODULE_FROM_BUN_TEST]],
    ['import {} from "bun:test";', [IMPORT_TYPE_SIDE_EFFECTS]],
    ['import {} from "vitest";', [IMPORT_TYPE_SIDE_EFFECTS]],
    ['import {} from "node:assert";', [IMPORT_TYPE_SIDE_EFFECTS]],
    [
      'import "vitest/node";',
      [UNASSIGNED_IMPORT, "sshkeda(no-test-runners): imports a test runner from vitest/node"],
    ],
  ]),
);

export const restrictedImportsInTheTestHome = Task.make(
  "in tests/, assertions pass while a test runner, a whole bun:test namespace, a load of bun:test that names nothing and an import() of an assertion module are each reported once by their ban, with the load that names nothing also reported by import(no-unassigned-import)",
  expectEachCaseReports("tests/shared", [
    ['import { expect } from "bun:test";\n\nexport const USED = [expect];', []],
    ['import assert from "node:assert/strict";\n\nexport const USED = [assert];', []],
    [
      'import { describe } from "bun:test";\n\nexport const USED = [describe];',
      [runnerFromBunTest("describe")],
    ],
    [
      'import * as runner from "bun:test";\n\nexport const USED = [runner.describe];',
      [runnerFromBunTest("runner")],
    ],
    ['import "bun:test";', [UNASSIGNED_IMPORT, RUNNER_MODULE_FROM_BUN_TEST]],
    ['import { join } from "node:path";\n\nexport const USED = [join];', [NODE_PATH]],
    ['export const load = () => import("node:assert");', [DYNAMIC_IMPORT]],
  ]),
);

export const builtinImportsInFilesGrantedDynamicImports = Task.make(
  "a file granted importsDynamically may import() a module no rule bans, but a literal import() of a module a ban covers is still reported once, by that module's ban",
  expectEachCaseReports(
    "src",
    [
      ['export const load = () => import("node:path");', [NODE_PATH]],
      [
        'export const load = () => import("node:child_process");',
        [
          "sshkeda(no-command-spawn): node:child_process starts a command in a way no file may; start it through Effect ChildProcess in a file allowed spawnsCommands",
        ],
      ],
      [
        'export const load = () => import("bun:sqlite");',
        [
          "sshkeda(no-sql-clients): bun:sqlite is a SQL client no file may use; use Effect SQL in a file allowed usesSqlDatabases",
        ],
      ],
      [
        'export const load = () => import("node:fs/promises");',
        [
          "sshkeda(no-node-file-system): node:fs/promises reaches the file system in a way no file may; use the Effect FileSystem service, or take a file lock with open from node:fs/promises and constants from node:fs in a file allowed locksFiles",
        ],
      ],
      ['export const load = () => import("./local.ts");', []],
      ["export const load = (name: string) => import(name);", []],
    ],
    ["importsDynamically"],
  ),
);

const MODULE_IN_A_PATTERN = "x";

const moduleOfPattern = (pattern: string) =>
  pattern.replaceAll(MODULE_PATTERN_WILDCARD, MODULE_IN_A_PATTERN);

const DYNAMIC_IMPORTS = "importsDynamically";

const NODE_BUILTIN_BANS = Object.entries(NODE_BUILTIN_RULES).flatMap(([rule, { modules }]) =>
  modules.flatMap((module) =>
    [`node:${module}`, module, `bun:${module}`].map((specifier) => ({
      module: specifier,
      rule: `sshkeda(${rule})`,
    })),
  ),
);

const BANNED_MODULES = [
  ...NODE_BUILTIN_BANS.map(({ module }) => module),
  BUN_TEST,
  ...TEST_RUNNER_MODULES,
  "vitest/x",
  ...GRANTABLE_BAN_NAMES.flatMap((permission) =>
    bansByKind(everyBanOf(PERMISSION_BANS[permission])).module.flatMap(({ modulePatterns }) =>
      modulePatterns.flatMap((pattern) => equivalentModuleSpecifiers(moduleOfPattern(pattern))),
    ),
  ),
  ...ASSERTION_MODULES,
  ...EFFECT_TESTING_MODULES,
];

const UNBOUND_METHOD = "typescript(unbound-method)";

const rulesOf = (errors: readonly string[]) =>
  errors
    .filter((error) => !UNUSED_GRANT.test(error))
    .map((error) => error.slice(0, error.indexOf(": ")))
    .filter((rule) => rule !== PREFER_NODE_PROTOCOL && rule !== UNBOUND_METHOD);

const expectEachGrantedCaseReportsOnce = (
  directory: string,
  cases: readonly {
    readonly code: string;
    readonly allow: readonly string[];
    readonly rules: readonly string[];
  }[],
  enclosingGrants: Readonly<Record<string, { readonly allow: readonly string[] }>> = {},
) =>
  Effect.gen(function* () {
    const linted = yield* lintErrorsOfGrantedCases(
      oxlintReport,
      REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      directory,
      cases,
      enclosingGrants,
    );
    expect(linted.map(({ code, errors }) => ({ code, rules: rulesOf(errors) }))).toEqual(
      cases.map(({ code, rules }) => ({ code, rules: [...rules] })),
    );
  });

const literalImportOf = (module: string) => `export const load = () => import("${module}");`;

const literalImportCases = (allow: readonly string[]) =>
  NODE_BUILTIN_BANS.map(({ module, rule }) => ({
    code: literalImportOf(module),
    allow,
    rules: [rule],
  }));

const GRANTS_AROUND_A_MODULE_BAN = [[], [DYNAMIC_IMPORTS], GRANTABLE_BAN_NAMES];

export const literalImportsOfEveryBuiltin = Task.make(
  "a literal import() of a Node built-in Effect replaces is reported once, by that module's ban, in a file granted nothing, importsDynamically or every permission",
  Effect.gen(function* () {
    for (const allow of GRANTS_AROUND_A_MODULE_BAN) {
      yield* expectEachGrantedCaseReportsOnce("src", literalImportCases(allow));
    }
  }),
);

export const literalImportsOfEveryBuiltinInTheTestHome = Task.make(
  "in tests/, a literal import() of a Node built-in Effect replaces is reported once, by that module's ban, whatever the file is granted",
  Effect.gen(function* () {
    for (const allow of GRANTS_AROUND_A_MODULE_BAN) {
      yield* expectEachGrantedCaseReportsOnce("tests/shared", literalImportCases(allow));
    }
  }),
);

export const emptyNamedImportsOfEveryBannedModule = Task.make(
  "import {} from a banned module is reported once, by typescript(no-import-type-side-effects), like import {} from bun:test",
  expectEachGrantedCaseReportsOnce(
    "src",
    BANNED_MODULES.map((module) => ({
      code: `import {} from "${module}";`,
      allow: [],
      rules: ["typescript(no-import-type-side-effects)"],
    })),
  ),
);

const RESTRICTED_MEMBER_RULE = "eslint(no-restricted-imports)";

const BUN_ALIAS_PROTOCOL = "bun:";

export const importsOfEveryRestrictedMember = Task.make(
  "a named import of a restricted Bun or process member is reported once, by no-restricted-imports, from bun:process too, and a type-only import of it is not where TypeScript knows the module",
  expectEachGrantedCaseReportsOnce(
    "src",
    RESTRICTED_IMPORT_PATHS.flatMap(({ name: module, importNames }) =>
      importNames.flatMap((name) => [
        {
          code: `import { ${name} } from "${module}";\n\nexport const USED = [${name}];`,
          allow: [],
          rules: [RESTRICTED_MEMBER_RULE],
        },
        {
          code: `import { ${name} as alias } from "${module}";\n\nexport const USED = [alias];`,
          allow: [],
          rules: [RESTRICTED_MEMBER_RULE],
        },
        ...(module.startsWith(BUN_ALIAS_PROTOCOL)
          ? []
          : [
              {
                code: `import type { ${name} } from "${module}";\n\nexport const read = (reader: typeof ${name}) => reader;`,
                allow: [],
                rules: [],
              },
            ]),
      ]),
    ),
  ),
);

const reExportCases = [
  ['export * from "node:path";', "export * from node:path"],
  ['export type * from "bun:test";', "export * from bun:test"],
  ['export * as namespace from "effect/testing";', "export * as namespace from effect/testing"],
  ['export { spawn } from "node:child_process";', "export from node:child_process"],
  ['export type { expect } from "bun:test";', "export from bun:test"],
  ['export { mock } from "effect/Layer";', "export from effect/Layer"],
].map(
  ([code = "", reExport = ""]) =>
    [code, [`sshkeda(no-re-exports): ${reExport} re-exports another module`]] as const,
);

export const reExportsOfEveryBannedModule = Task.make(
  "a re-export of a module or a name that a rule bans, export *, export * as, export { x } or their type-only forms, is reported once, by no-re-exports",
  expectEachCaseReports("src", reExportCases),
);

export const reExportsInFilesGrantedEverything = Task.make(
  "a file granted every permission still gets the one no-re-exports report for each re-export of a banned module or name",
  expectEachCaseReports("src", reExportCases, GRANTABLE_BAN_NAMES),
);
