import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";
import { parseSync } from "oxc-parser";

import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { oxlintBinary } from "../shared/oxlint-binary.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const NODE_MODULES = "node_modules";
const EFFECT_PACKAGE = "effect";
const EFFECT_SCOPE = "@effect";
const DECLARATION_DIRECTORY = "dist";
const DECLARATION_EXTENSION = ".d.ts";
const TESTING_ENTRY_POINT = "testing";
const TESTING_CATEGORY = /@category testing\b/u;
const TEST_MODULE_NAME = /^Test|Test$/u;
const SOURCE_FILE = "src/console.ts";
const TEST_FILE = "tests/console.ts";

const declaredNames = (text: string, fileName: string) => {
  const parsed = parseSync(fileName, text);
  return parsed.program.body.flatMap((statement) => {
    if (statement.type !== "ExportNamedDeclaration") {
      return [];
    }
    if (statement.declaration === null) {
      return [];
    }
    const documentation = parsed.comments.findLast(
      (comment) =>
        comment.end <= statement.start && text.slice(comment.end, statement.start).trim() === "",
    );
    const isTestingDocumentation =
      documentation !== undefined && TESTING_CATEGORY.test(documentation.value);
    if (!isTestingDocumentation) {
      return [];
    }
    const declaration = statement.declaration;
    if (declaration.type === "VariableDeclaration") {
      return declaration.declarations.flatMap((declarator) =>
        declarator.id.type === "Identifier" ? [declarator.id.name] : [],
      );
    }
    const declaredId = "id" in declaration ? declaration.id : undefined;
    return declaredId?.type === "Identifier" ? [declaredId.name] : [];
  });
};

const testingHelpersOf = (packageName: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const declarations = path.resolve(NODE_MODULES, packageName, DECLARATION_DIRECTORY);
    if (!(yield* fileSystem.exists(declarations))) {
      return { modules: [], exports: [] };
    }
    const modulePaths = (yield* fileSystem.glob(`**/*${DECLARATION_EXTENSION}`, {
      root: declarations,
      exclude: ["**/internal"],
    }))
      .map((file) => file.slice(0, -DECLARATION_EXTENSION.length))
      .filter((modulePath) => path.basename(modulePath) !== "index");
    const testingIndex = path.join(declarations, TESTING_ENTRY_POINT, "index.d.ts");
    const reExportedByTesting = (yield* fileSystem.exists(testingIndex))
      ? [
          TESTING_ENTRY_POINT,
          ...parseSync(
            testingIndex,
            yield* fileSystem.readFileString(testingIndex),
          ).module.staticExports.flatMap((declaration) =>
            declaration.entries.flatMap((entry) =>
              entry.moduleRequest === null
                ? []
                : [`${TESTING_ENTRY_POINT}/${path.basename(entry.moduleRequest.value, ".ts")}`],
            ),
          ),
        ]
      : [];
    const modules = new Set([
      ...reExportedByTesting,
      ...modulePaths.filter((modulePath) => TEST_MODULE_NAME.test(path.basename(modulePath))),
    ]);
    const exports: [string, string[]][] = [];
    for (const modulePath of modulePaths.filter((candidate) => !modules.has(candidate))) {
      const fileName = path.join(declarations, `${modulePath}${DECLARATION_EXTENSION}`);
      const names = declaredNames(yield* fileSystem.readFileString(fileName), fileName);
      if (names.length > 0) {
        exports.push([`${packageName}/${modulePath}`, names.toSorted()]);
      }
    }
    return {
      modules: [...modules].map((modulePath) => `${packageName}/${modulePath}`),
      exports,
    };
  });

const derivedTestingHelpers = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scopedPackages = yield* fileSystem.glob("*", {
    root: path.resolve(NODE_MODULES, EFFECT_SCOPE),
  });
  const packages = yield* Effect.forEach(
    [EFFECT_PACKAGE, ...scopedPackages.map((name) => `${EFFECT_SCOPE}/${name}`)],
    testingHelpersOf,
  );
  return {
    modules: packages.flatMap((helpers) => helpers.modules).toSorted(),
    exports: Object.fromEntries(packages.flatMap((helpers) => helpers.exports)),
  };
});

export const testingHelpersMatchTheInstalledEffect = Task.make(
  "no-testing-helpers refuses every effect/testing module, Test-named module and export the installed effect and @effect packages tag @category testing",
  Effect.gen(function* () {
    const derived = yield* derivedTestingHelpers;
    expect(derived.modules.length).toBeGreaterThan(0);
    yield* ruleTest("no-testing-helpers", {
      valid: [],
      invalid: [
        ...derived.modules.map((modulePath) => `import * as Helper from "${modulePath}";`),
        ...Object.entries(derived.exports).flatMap(([modulePath, names]) =>
          names.map((name) => `import { ${name} } from "${modulePath}";`),
        ),
      ].map((code) => ({ code, errors: [{ messageId: "testingHelper" }] })),
    });
  }),
);

const TESTING_HELPER_USES = [
  'import { TestConsole } from "effect/testing";',
  'import { TestConsole as Console } from "effect/testing";',
  'import * as Testing from "effect/testing";',
  'import type { TestClock } from "effect/testing";',
  'import "effect/testing";',
  'import * as TestClock from "effect/testing/TestClock";',
  'import { layer } from "effect/testing/TestConsole";',
  'import * as TestRunner from "effect/cluster/TestRunner";',
  'import { TestRunner as InMemoryCluster } from "effect/cluster";',
  'import { RpcTest } from "effect/rpc";',
  'import { makeClient } from "effect/rpc/RpcTest";',
  'import { HttpApiTest } from "effect/http-api";',
  'import { mock as fake } from "effect/Layer";',
  'import { layerTestClient } from "effect/http/HttpServer";',
  'import { layerTest } from "@effect/platform-bun/BunHttpServer";',
  'import { BunHttpServer } from "@effect/platform-bun"; BunHttpServer.layerTest;',
  'import * as Effect from "effect"; Effect.Layer.mock;',
  'import { HttpServer } from "effect/http"; HttpServer.makeTestClient;',
  'import { Entity } from "effect/cluster"; Entity.makeTestClient;',
  'import * as Cluster from "effect/cluster"; Cluster.TestRunner.layer;',
  'import * as Cluster from "effect/cluster"; Cluster["TestRunner"].layer;',
  'import * as Cluster from "effect/cluster"; type Runner = typeof Cluster.TestRunner.layer;',
  'import type * as Http from "effect/http"; type Client = Http.HttpServer.makeTestClient;',
] as const;

export const refusesTestingHelpers = Task.make(
  "no-testing-helpers refuses Effect's testing helpers imported, aliased, namespaced, or in type positions, and leaves re-exports to no-re-exports and import {} to no-import-type-side-effects",
  ruleTest("no-testing-helpers", {
    valid: [
      'import { Effect, Layer } from "effect"; Layer.succeed;',
      'import { Sharding } from "effect/cluster";',
      'import * as Cluster from "effect/cluster"; Cluster.Sharding.layer;',
      'import { HttpServer } from "effect/http"; HttpServer.serve;',
      'import { BunHttpServer } from "@effect/platform-bun"; BunHttpServer.layer;',
      'import { layerTest } from "@other/platform-bun/BunHttpServer";',
      'import { TestConsole } from "./test-console.ts";',
      "const Layer = { mock: 1 }; Layer.mock;",
      'export * from "effect/Schema";',
      'export * from "effect/rpc";',
      'export { TestConsole } from "effect/testing";',
      'export { TestRunner as InMemoryCluster } from "effect/cluster";',
      'export { mock } from "effect/Layer";',
      'export * from "effect/testing";',
      'export * as Testing from "effect/testing";',
      'export * from "effect/cluster";',
      'export * as Layer from "effect/Layer";',
      'export * from "effect";',
      'export * from "@effect/platform-bun";',
      'import {} from "effect/testing";',
    ],
    invalid: [
      {
        code: 'import { TestConsole } from "effect/testing";\nEffect.provide(TestConsole.layer);',
        errors: [
          {
            message: "uses Effect's testing helper effect/testing outside a test file",
          },
        ],
      },
      {
        code: 'import { Layer } from "effect";\nLayer.mock(Service)({});',
        errors: [
          {
            message: "uses Effect's testing helper Layer.mock outside a test file",
          },
        ],
      },
      {
        code: 'import { Sharding, TestRunner } from "effect/cluster";',
        errors: [
          {
            message: "uses Effect's testing helper effect/cluster/TestRunner outside a test file",
          },
        ],
      },
      {
        code: 'import * as Bun from "@effect/platform-bun";\nLayer.provide(Bun.BunHttpServer.layerTest);',
        errors: [
          {
            message: "uses Effect's testing helper BunHttpServer.layerTest outside a test file",
          },
        ],
      },
      ...TESTING_HELPER_USES.map((code) => ({ code, errors: [{ messageId: "testingHelper" }] })),
    ],
  }),
);

export const testHomeIsExemptFromTestCodeRules = Task.make(
  "oxlint refuses testing helpers and assertions in a source file and allows them in tests/",
  Effect.gen(function* () {
    const testCode = [
      'import { expect } from "bun:test";',
      'import { TestConsole } from "effect/testing";',
      "",
      "export const CHECKED = [expect, TestConsole.layer];",
      "",
    ].join("\n");
    const { directory } = yield* makeProject({ [SOURCE_FILE]: testCode, [TEST_FILE]: testCode });
    const output = yield* Task.exec(
      "bun",
      [
        yield* oxlintBinary,
        "--config",
        "oxlint.config.ts",
        "--format",
        "agent",
        SOURCE_FILE,
        TEST_FILE,
      ],
      { cwd: directory },
    ).pipe(
      Effect.as(""),
      Effect.catchTag("CommandFailed", (failure) =>
        Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
      ),
    );
    expect(output).toContain(
      `${SOURCE_FILE}:1:10: error sshkeda(no-assertions): asserts with expect from bun:test outside tests/`,
    );
    expect(output).toContain(
      `${SOURCE_FILE}:2:29: error sshkeda(no-testing-helpers): uses Effect's testing helper effect/testing outside a test file`,
    );
    expect(output).not.toContain(TEST_FILE);
  }).pipe(Effect.scoped),
);

export const onlyScriptsImportTestHome = Task.make(
  "only scripts/ and tests/ files import tests, while src imports are TestImported",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "tests/console.ts":
        'export { TestConsole } from "effect/testing";\nexport const HELPER = 1;\n',
      "tests/uses-console.ts":
        'import { HELPER } from "./console.ts";\nexport const USED = HELPER;\n',
      "scripts/ci.ts":
        'import { HELPER } from "../tests/console.ts";\nexport const RUN = HELPER;\n',
      "scripts/shared/helpers.ts":
        'export { TestConsole } from "../../tests/console.ts";\nexport const SHARED = 1;\n',
      [SOURCE_FILE]: 'import { HELPER } from "../tests/console.ts";\nexport const USED = HELPER;\n',
    });
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual(
      [
        `${SOURCE_FILE}:1: error TestImported: imports tests/console.ts, but only scripts/ and tests/ may import tests/`,
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);
