import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Duration, Effect, Schema, Array as Arrays, flow } from "effect";

import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import { TestNotRun } from "../../src/lib/tasks/lib/place-exports-in-the-narrowest-directory/internal/export-placement-errors.ts";
import { findExportPlacementViolations } from "../../src/lib/tasks/lib/place-exports-in-the-narrowest-directory/internal/find-export-placement-violations.ts";
import { isSubdividedAmong } from "../../src/lib/tasks/lib/place-exports-in-the-narrowest-directory/internal/find-subdivided-directories.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const everyPlacementViolationIn = (
  sources: Readonly<Record<string, string>>,
  lintConfig = "lintConfig({})",
) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "placement", "type": "module", "main": "./src/index.ts" }\n',
        ...sources,
      },
      lintConfig,
    );
    return yield* findExportPlacementViolations(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as([]),
      Effect.catchTag("ExportPlacementViolations", (failure) => Effect.succeed(failure.violations)),
    );
  });

const placementViolationsIn = (
  sources: Readonly<Record<string, string>>,
  lintConfig = "lintConfig({})",
) =>
  everyPlacementViolationIn(sources, lintConfig).pipe(
    Effect.map((violations) =>
      taggedViolations(
        violations.filter((violation) => !Schema.is(TestNotRun)(violation)),
      ).toSorted(),
    ),
  );

const unused = (location: string, name: string) =>
  `${location}: error UnusedExport: export ${name} is used by nothing`;

const deadUsed = (location: string, name: string, user: string) =>
  `${location}: error UnusedExport: export ${name} is used only by unreached code, such as ${user}`;

const testOnly = (location: string, name: string) =>
  `${location}: error TestOnlyExport: export ${name} is used only by tests`;

const scriptOnly = (location: string, name: string, users: string) =>
  `${location}: error ScriptOnlyExport: export ${name} is used only by ${users}`;

const directoryOfPath = (path: string) => path.split("/").slice(0, -1).join("/");

const UNCOUNTED_USERS = "outside tests and unreached code";

const EXPORTS_IN_A_LARGE_FILE = 20_000;

const MOST_MILLISECONDS_TO_PLACE_EXPORTS_OF_A_LARGE_FILE = 30_000;

const besideSubdirectories = (path: string) =>
  `${path}: error FileBesideSubdirectories: sits directly in ${directoryOfPath(path)}/, which has subdirectories that hold code`;

const outsideModuleLayout = (path: string, module: string) =>
  directoryOfPath(path) === module
    ? `${path}: error FileOutsideModuleLayout: sits directly in the module ${module}/, not in its internal/ or shared/`
    : `${path}: error FileOutsideModuleLayout: sits in ${directoryOfPath(path)}/, which is inside the module ${module}/ but is not its internal/, its shared/ or a module in its lib/`;

const sharedByOne = (path: string, module: string, part?: string) =>
  part === undefined
    ? `${path}: error SharedFileWithOneUser: is in ${module}/shared/, but no submodule of ${module}/ uses it ${UNCOUNTED_USERS}`
    : `${path}: error SharedFileWithOneUser: is in ${module}/shared/, but only ${part}/ uses it ${UNCOUNTED_USERS}`;

export const scriptHelpersMayServeOnlyTests = Task.make(
  "scripts may export reusable test helpers while unused script exports and test-only production exports remain errors",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": "export const MAIN = 1;\n",
        "src/internal/only.ts": "export const SOURCE = 1;\n",
        "scripts/shared/fixture.ts": "export const FIXTURE = 1;\nexport const UNUSED = 2;\n",
        "tests/runs.ts":
          'import { SOURCE } from "../src/internal/only.ts";\nimport { FIXTURE } from "../scripts/shared/fixture.ts";\nexport const test = () => SOURCE + FIXTURE;\n',
        "scripts/ci.ts": 'import { test } from "../tests/runs.ts";\nexport const RUN = test;\n',
      }),
    ).toEqual([
      unused("scripts/shared/fixture.ts:2", "UNUSED"),
      testOnly("src/internal/only.ts:1", "SOURCE"),
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const sourceExportsOnlyScriptsUseAreReported = Task.make(
  "an export in src/ that only scripts, or only tests and scripts, use is ScriptOnlyExport, while a script that uses what src/index.ts exports, as an app's entry point does, or builds a src/ file passes, and a src/ user still counts",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "package.json": '{ "name": "placement", "type": "module" }\n',
        "src/index.ts": 'export { app } from "./internal/app.ts";\n',
        "src/internal/app.ts": [
          'import { CONFIG } from "../lib/config/index.ts";',
          "export const app = () => CONFIG;",
          "",
        ].join("\n"),
        "src/lib/config/index.ts": "export const CONFIG = 1;\n",
        "src/lib/deploy/index.ts":
          "export const deploy = () => 1;\nexport const harness = () => 2;\n",
        "src/lib/edge/index.ts": "export default { fetch: () => 1 };\n",
        "scripts/main.ts": [
          'import { app } from "../src/index.ts";',
          'import { CONFIG } from "../src/lib/config/index.ts";',
          "export const MAIN = [app, CONFIG];",
          "",
        ].join("\n"),
        "scripts/internal/deploy-stage.ts":
          'import { deploy, harness } from "../../src/lib/deploy/index.ts";\nexport const stage = [deploy, harness];\n',
        "scripts/deploy.ts": [
          'import { stage } from "./internal/deploy-stage.ts";',
          'export const BUILT = Bun.build({ entrypoints: ["src/lib/edge/index.ts"], outdir: "dist" });',
          "export const DEPLOY = stage;",
          "",
        ].join("\n"),
        "tests/harness.ts":
          'import { harness } from "../src/lib/deploy/index.ts";\nexport const test = harness;\n',
        "scripts/ci.ts": 'import { test } from "../tests/harness.ts";\nexport const CI = test;\n',
      }),
    ).toEqual(
      [
        scriptOnly("src/lib/deploy/index.ts:1", "deploy", "scripts"),
        scriptOnly("src/lib/deploy/index.ts:2", "harness", "tests and scripts"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const unusedAndTestOnlyExportsAreReported = Task.make(
  "an export nothing uses is UnusedExport, one only tests use is TestOnlyExport, and package entries, scripts and root tool configs are pinned",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts":
          'import { PUBLIC } from "./internal/public.ts";\nexport const MAIN = PUBLIC;\n',
        "src/internal/public.ts": "export const PUBLIC = 1;\n",
        "src/shared/values.ts":
          "export const USED = 1;\nexport const NOBODY = 2;\nexport const TESTED = 3;\n",
        "src/tasks/run.ts":
          'import { USED } from "../shared/values.ts";\nexport const RUN = USED;\n',
        "src/rules/rule.ts":
          'import { USED } from "../shared/values.ts";\nexport const RULE = USED;\n',
        "scripts/build.ts": "export const BUILD = 1;\n",
        "tests/values.ts":
          'import { TESTED } from "../src/shared/values.ts";\nexport const CHECKED = TESTED;\n',
        "vite.config.ts": "export default {};\n",
      }),
    ).toEqual(
      [
        unused("src/rules/rule.ts:2", "RULE"),
        deadUsed("src/shared/values.ts:1", "USED", "src/rules/rule.ts"),
        unused("src/shared/values.ts:2", "NOBODY"),
        unused("src/tasks/run.ts:2", "RUN"),
        testOnly("src/shared/values.ts:3", "TESTED"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const exportsOfALargeFileArePlacedInLinearTime = Task.make(
  "export placement reports each of 20,000 unused exports in one file, each with its line, in under 30 seconds",
  Effect.gen(function* () {
    const [elapsed, violations] = yield* Effect.timed(
      placementViolationsIn({
        "src/index.ts":
          'import { VALUE_0 } from "./internal/table.ts";\nexport const MAIN = VALUE_0;\n',
        "src/internal/table.ts": Array.from(
          { length: EXPORTS_IN_A_LARGE_FILE },
          (_value, index) => `export const VALUE_${index} = ${index};\n`,
        ).join(""),
      }),
    );
    expect(violations).toEqual(
      Array.from({ length: EXPORTS_IN_A_LARGE_FILE }, (_value, index) =>
        unused(`src/internal/table.ts:${index + 1}`, `VALUE_${index}`),
      )
        .slice(1)
        .toSorted(),
    );
    expect(Duration.toMillis(elapsed)).toBeLessThan(
      MOST_MILLISECONDS_TO_PLACE_EXPORTS_OF_A_LARGE_FILE,
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const sharedFilesUsedByOneChildModuleAreReported = Task.make(
  "a shared/ file whose production users all sit in one child module is SharedFileWithOneUser naming that module, a file used more widely is not reported even when some exports serve one child, and a user in the same shared/ passes on its own users",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { both } from "./shared/mixed.ts";',
          'import { FOLDED } from "./shared/folded.ts";',
          'import { RUN } from "./tasks/index.ts";',
          'import { RULE } from "./rules/index.ts";',
          "export const MAIN = [both, FOLDED, RUN, RULE];",
          "",
        ].join("\n"),
        "src/shared/mixed.ts": "export const both = 1;\n",
        "src/shared/folded.ts": "export const FOLDED = 1;\nexport const HELPER = 2;\n",
        "src/shared/user.ts":
          'import { HELPER } from "./folded.ts";\nexport const HELPED = HELPER;\n',
        "src/tasks/index.ts": [
          'import { HELPED } from "../shared/user.ts";',
          'import { INNER } from "./inner/index.ts";',
          "export const RUN = [HELPED, INNER];",
          "",
        ].join("\n"),
        "src/tasks/inner/index.ts":
          'import { both } from "../../shared/mixed.ts";\nexport const INNER = both;\n',
        "src/rules/index.ts":
          'import { HELPED } from "../shared/user.ts";\nexport const RULE = HELPED;\n',
      }),
    ).toEqual([]);
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { both } from "./shared/mixed.ts";',
          'import { RUN } from "./tasks/index.ts";',
          "export const MAIN = [both, RUN];",
          "",
        ].join("\n"),
        "src/shared/mixed.ts":
          "export const forTasks = 1;\nexport const alsoForTasks = 2;\nexport const both = 3;\n",
        "src/shared/moved.ts": "export const ONLY = 1;\nexport const ALSO = 2;\n",
        "src/tasks/index.ts": [
          'import { forTasks } from "../shared/mixed.ts";',
          'import { ONLY } from "../shared/moved.ts";',
          'import { INNER } from "./inner/index.ts";',
          "export const RUN = [forTasks, ONLY, INNER];",
          "",
        ].join("\n"),
        "src/tasks/inner/index.ts": [
          'import { ALSO } from "../../shared/moved.ts";',
          'import { alsoForTasks } from "../../shared/mixed.ts";',
          "export const INNER = [ALSO, alsoForTasks];",
          "",
        ].join("\n"),
      }),
    ).toEqual([sharedByOne("src/shared/moved.ts", "src", "src/tasks")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const sameFileUsersKeepExportsInPlace = Task.make(
  "an export referenced by non-exported code in its own file counts the file as a user, an export referenced inside another export inherits that export's users, as an RPC schema does from its group, and an unreached file keeps nothing alive",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { Rpcs } from "./internal/rpc.ts";',
          'import { decoded } from "./internal/schema.ts";',
          "export const MAIN = [Rpcs, decoded];",
          "",
        ].join("\n"),
        "src/internal/rpc.ts": [
          "export const Request = { tag: 'Request' };",
          "export const Rpcs = { requests: [Request] };",
          "",
        ].join("\n"),
        "src/internal/schema.ts": [
          "export const Shape = { tag: 'Shape' };",
          "const decode = (input: unknown) => [Shape, input];",
          "export const decoded = decode(1);",
          "",
        ].join("\n"),
        "src/server/server.ts": [
          'import { Request } from "../internal/rpc.ts";',
          'import { Shape } from "../internal/schema.ts";',
          "export const SERVER = [Request, Shape];",
          "",
        ].join("\n"),
      }),
    ).toEqual(
      [
        unused("src/server/server.ts:3", "SERVER"),
        deadUsed("src/internal/schema.ts:1", "Shape", "src/server/server.ts"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const everyKindOfImportCountsAsUse = Task.make(
  "namespace, type, dynamic, require, import type and new URL imports all count as uses",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import * as Everything from "./internal/namespace.ts";',
          'import type { Shape } from "./internal/types.ts";',
          'export const lazy = () => import("./internal/dynamic.ts");',
          'export const required = require("./internal/required.ts");',
          'export type Imported = import("./internal/imported-type.ts").Imported;',
          'export const worker = new URL("./internal/worker.ts", import.meta.url);',
          "export const MAIN: Shape = Everything;",
          "",
        ].join("\n"),
        "src/internal/namespace.ts": "export const A = 1;\nexport const B = 2;\n",
        "src/internal/types.ts": "export type Shape = object;\n",
        "src/internal/dynamic.ts": "export const DYNAMIC = 1;\n",
        "src/internal/required.ts": "export const REQUIRED = 1;\n",
        "src/internal/imported-type.ts": "export type Imported = string;\n",
        "src/internal/worker.ts": "export const WORKER = 1;\n",
      }),
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const aQualifiedImportTypeUsesOnlyTheExportItNames = Task.make(
  'an import type with a qualifier, such as import("./a.ts").Shape or import("./a.ts").Shapes.Circle, uses only the export its qualifier starts with, while typeof import("./a.ts") uses every export',
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'export type Named = import("./internal/named.ts").Named;',
          'export type Inner = import("./internal/nested.ts").Space.Inner;',
          'export type Whole = typeof import("./internal/whole.ts");',
          "",
        ].join("\n"),
        "src/internal/named.ts": "export type Named = string;\nexport type Unnamed = number;\n",
        "src/internal/nested.ts":
          "export namespace Space {\n  export type Inner = string;\n}\nexport type Outer = number;\n",
        "src/internal/whole.ts": "export const FIRST = 1;\nexport const SECOND = 2;\n",
      }),
    ).toEqual(
      [
        unused("src/internal/named.ts:2", "Unnamed"),
        unused("src/internal/nested.ts:4", "Outer"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const aNewUrlUsesEveryExportAndAWorkerNone = Task.make(
  "a new URL target that nothing launches may be handed to a tool that reads its exports, so its default export counts as used, while a Worker started from a URL uses none of its target's exports",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'export const STACK = new URL("./internal/stack.ts", import.meta.url);',
          'export const THREAD = new Worker(new URL("./internal/thread.ts", import.meta.url));',
          "",
        ].join("\n"),
        "src/internal/stack.ts": "export default { name: 1 };\n",
        "src/internal/thread.ts": "export const THREAD_EXPORT = 1;\n",
      }),
    ).toEqual([unused("src/internal/thread.ts:1", "THREAD_EXPORT")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const onlyRecognizedLoadsAreReached = Task.make(
  "reaching starts from package.json main, module and exports (wildcards too, minus null exclusions) and bunfig preload and test preload read as TOML, not from a package.json bin, and follows literal import(), new URL and template literals without substitutions; a path written as a plain string loads nothing",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn(
        {
          "package.json":
            '{ "name": "placement", "type": "module", "main": "./src/index.ts", "bin": { "placement": "./src/cli/main.ts" }, "exports": { "./jobs/*": "./src/jobs/*.ts", "./jobs/hidden": null } }\n',
          "bunfig.toml": [
            '# preload = ["./src/dead/dead.ts"]',
            'preload = ["./src/preload/setup.ts"]',
            "[test]",
            'preload = "./src/preload/test-setup.ts"',
            "",
          ].join("\n"),
          "src/preload/test-setup.ts": "export const TEST_SETUP = 1;\n",
          "src/jobs/hidden.ts": "export const HIDDEN = 1;\n",
          "src/index.ts": [
            "export const lazy = () => import(`./internal/load.ts`);",
            'export const worker = new URL("./internal/run.ts", import.meta.url);',
            "",
          ].join("\n"),
          "src/cli/main.ts": "export const CLI = 1;\n",
          "src/jobs/listed.ts": "export const LISTED = 1;\n",
          "src/preload/setup.ts": "export const SETUP = 1;\n",
          "src/internal/load.ts": "export const LAZY = 1;\n",
          "src/internal/run.ts": "export const WORKER = 1;\n",
          "src/dead/dead.ts": "export const DEAD = 1;\n",
          "src/granted/granted.ts": "export const GRANTED = 1;\n",
          "scripts/build.ts":
            'export const ENTRY_POINTS = ["./src/dead/dead.ts", "src/dead/dead.ts"];\n',
          "tests/paths.ts":
            'export const LOADED = new URL("../src/granted/granted.ts", import.meta.url);\n',
        },
        'lintConfig({ "src/granted/granted.ts": { allow: ["usesSqlDatabases"] } })',
      ),
    ).toEqual(
      [
        unused("src/cli/main.ts:1", "CLI"),
        unused("src/dead/dead.ts:1", "DEAD"),
        unused("src/jobs/hidden.ts:1", "HIDDEN"),
        testOnly("src/granted/granted.ts:1", "GRANTED"),
        unused("src/preload/setup.ts:1", "SETUP"),
        unused("src/preload/test-setup.ts:1", "TEST_SETUP"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const shadowedNamesAreNotSameFileUses = Task.make(
  "a same-file reference counts only when it resolves to the top-level export, so a shadowing parameter, local, catch binding or generic type parameter does not keep an export in use, while production use in its own file counts even when tests also import it",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": 'import { RUN } from "./internal/tools.ts";\nexport const MAIN = RUN;\n',
        "src/internal/tools.ts": [
          "export const SHADOWED = 1;",
          "export const PREFIX = 'TASK';",
          "const read = (SHADOWED: number) => SHADOWED;",
          "const local = () => { const SHADOWED = 2; return SHADOWED; };",
          "const caught = () => { try { return 1; } catch (SHADOWED) { return SHADOWED; } };",
          "export const Shape = { size: 1 };",
          "function generic<Shape>(value: Shape): Shape { return value; }",
          `const name = \`\${PREFIX}_STATE\`;`,
          "export const RUN = [read, local, caught, name, generic];",
          "",
        ].join("\n"),
        "tests/tools.ts":
          'import { PREFIX } from "../src/internal/tools.ts";\nexport const CHECKED = PREFIX;\n',
      }),
    ).toEqual(
      [
        unused("src/internal/tools.ts:1", "SHADOWED"),
        unused("src/internal/tools.ts:6", "Shape"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const jsxElementsAreSameFileUses = Task.make(
  "a component rendered as JSX in its own .tsx file counts that file as a user",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "placement", "type": "module", "main": "./src/index.tsx" }\n',
        "src/index.tsx": 'import { Page } from "./internal/page.tsx";\nexport const MAIN = Page;\n',
        "src/internal/page.tsx": [
          "export const Button = () => null;",
          "export const Page = () => <Button />;",
          "",
        ].join("\n"),
      },
      "lintConfig({})",
      {
        compilerOptions: {
          strict: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          skipLibCheck: true,
          jsx: "preserve",
        },
        include: ["**/*.ts", "**/*.tsx"],
      },
    );
    yield* findExportPlacementViolations(tsconfigFile, openTypeScriptProjects(tsconfigFile));
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const onlyInternalSharedDirectoriesFold = Task.make(
  "a shared/ directory counts as its parent's scope even when it holds an index.ts, and an index.ts in a directory nested in it makes no module either, so a file in it used only from that directory is SharedFileWithOneUser with no submodule as its user",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts":
          'import { SHARED } from "./shared/index.ts";\nexport const MAIN = SHARED;\n',
        "src/shared/index.ts":
          'import { FEATURE } from "./feature/index.ts";\nexport const SHARED = FEATURE;\n',
        "src/shared/util.ts": "export const UTIL = 1;\n",
        "src/shared/feature/index.ts":
          'import { UTIL } from "../util.ts";\nexport const FEATURE = UTIL;\n',
      }),
    ).toEqual([sharedByOne("src/shared/util.ts", "src")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const packageEntriesNameCompiledSourceFiles = Task.make(
  "package.json entries that name TypeScript source files are pinned, a types entry counts as one, and an entry naming no compiled file, even beside a tsconfig whose outDir and rootDir would map it, is PackageEntryWithoutSource",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "package.json":
          '{ "name": "placement", "type": "module", "types": "./src/lib/types/index.ts", "exports": { ".": "./src/index.ts", "./gone": "./src/lib/gone/index.ts", "./built": "./dist/index.js" } }\n',
        "tsconfig.build.json":
          '{ "extends": "./tsconfig.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" } }\n',
        "src/index.ts": "export const MAIN = 1;\n",
        "src/lib/types/index.ts": "export const TYPES = 1;\n",
      }),
    ).toEqual([
      "package.json: error PackageEntryWithoutSource: lists the entry ./src/lib/gone/index.ts, which names no file the TypeScript project compiles",
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const resolverFailuresAreLeftToTheImportBoundaryCheck = Task.make(
  "an import the resolver fails on, such as an empty path, resolves to no file here and is reported only by the import-boundary check",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": 'export const LOAD = () => import("");\n',
      }),
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const unparsableFilesAreReported = Task.make(
  "a source file that does not parse is SourceFileUnparsable at the line of its first parse error instead of being skipped",
  Effect.gen(function* () {
    const failure = yield* placementViolationsIn({
      "src/index.ts": 'export const GREETING = "hello";\n\nexport const FAREWELL = ;\n',
    }).pipe(failureAsValue);
    expect(taggedViolations([failure])).toEqual([
      "src/index.ts:3: error SourceFileUnparsable: does not parse: Unexpected token",
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

const OUTSIDE_IMPORT_MAP =
  '{ "name": "placement", "type": "module", "main": "./src/index.ts", "imports": { "#a": "./src/../../a.ts" } }\n';

const placementAndBoundaryFailuresOf = (source: string) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": OUTSIDE_IMPORT_MAP,
      "src/index.ts": source,
      "src/a.ts": "export const A = 1;\n",
    });
    const placement = yield* findExportPlacementViolations(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as("no failure"),
      Effect.catchTags({
        ExportPlacementViolations: (failure) =>
          Effect.succeed(taggedViolations(failure.violations).join("\n")),
        ModuleRequestUnresolvable: (failure) => Effect.succeed(failure._tag),
      }),
    );
    const boundary = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as("no failure"),
      Effect.catchTag("ModuleRequestUnresolvable", (failure) => Effect.succeed(failure._tag)),
    );
    return { placement, boundary };
  });

export const unresolvableImportsLeaveNoUnusedExport = Task.make(
  'a request the resolver fails on, such as "#a" mapped by package.json imports to a target outside the package, leaves no UnusedExport for its target: an import fails the import-boundary check with ModuleRequestUnresolvable and is left to it, and a URL the import-boundary check skips fails this check with ModuleRequestUnresolvable',
  Effect.gen(function* () {
    expect(
      yield* placementAndBoundaryFailuresOf('import { A } from "#a";\nexport const MAIN = A;\n'),
    ).toEqual({ placement: "no failure", boundary: "ModuleRequestUnresolvable" });
    expect(
      yield* placementAndBoundaryFailuresOf(
        'export const MAIN = new URL("#a", import.meta.url);\n',
      ),
    ).toEqual({ placement: "ModuleRequestUnresolvable", boundary: "no failure" });
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const filesOutsideTheProgramAreChecked = Task.make(
  "tracked source files outside the tsconfig include are checked, and declaration files count as users without being reported",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "placement", "type": "module", "main": "./src/index.ts" }\n',
        "src/index.ts": 'import { MAIN } from "./internal/main.ts";\nexport const ENTRY = MAIN;\n',
        "src/internal/main.ts": "export const MAIN = 1;\nexport const BUILT = 2;\n",
        "src/internal/shape.ts": "export interface Shape {\n  readonly size: number;\n}\n",
        "src/types/globals.d.ts":
          'import type { Shape } from "../internal/shape.ts";\nexport type Shapes = ReadonlyArray<Shape>;\n',
        "tools/generate.ts":
          'import { BUILT } from "../src/internal/main.ts";\nexport const GENERATED = BUILT;\n',
      },
      "lintConfig({})",
      { include: ["src/**/*.ts"] },
    );
    expect(
      yield* findExportPlacementViolations(tsconfigFile, openTypeScriptProjects(tsconfigFile)).pipe(
        Effect.as(new Array<string>()),
        Effect.catchTag("ExportPlacementViolations", (failure) =>
          Effect.succeed(taggedViolations(failure.violations).toSorted()),
        ),
      ),
    ).toEqual(
      [
        deadUsed("src/internal/main.ts:2", "BUILT", "tools/generate.ts"),
        unused("tools/generate.ts:2", "GENERATED"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const looseFilesUsedOnlyUnderASubmoduleAreOutsideTheLayout = Task.make(
  "a loose file in a module used only under one of its submodules is FileOutsideModuleLayout naming the module it sits in, and its users' directory is not reported",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts":
          'import { RUN } from "./area/index.ts";\nimport { JOB } from "./job/index.ts";\nexport const MAIN = [RUN, JOB];\n',
        "src/job/index.ts": 'import { STEP } from "../step.ts";\nexport const JOB = STEP;\n',
        "src/step.ts": "export const STEP = 1;\n",
        "src/area/index.ts": [
          'import { A } from "./part/index.ts";',
          'import { HELPER } from "../helper.ts";',
          "export const RUN = [A, HELPER];",
          "",
        ].join("\n"),
        "src/area/part/index.ts": [
          'import { HELPER } from "../../helper.ts";',
          'import { FLAT } from "../../flat-helper.ts";',
          "export const A = [HELPER, FLAT];",
          "",
        ].join("\n"),
        "src/helper.ts": "export const HELPER = 1;\n",
        "src/flat-helper.ts": "export const FLAT = 1;\n",
      }),
    ).toEqual([
      outsideModuleLayout("src/flat-helper.ts", "src"),
      outsideModuleLayout("src/helper.ts", "src"),
      outsideModuleLayout("src/step.ts", "src"),
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const aSharedFileUsedOnlyByAWorkerFileInASubmoduleHasOneUser = Task.make(
  "a shared/ file whose only user is a Worker's file sitting in a submodule is SharedFileWithOneUser like any other",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          "export const MAIN = 1;",
          'export const ROUTES = new Worker(new URL("./routes/index.ts", import.meta.url));',
          "",
        ].join("\n"),
        "src/routes/index.ts":
          'import { HELPER } from "../shared/helper.ts";\nexport const ROUTE = HELPER;\n',
        "src/shared/helper.ts": "export const HELPER = 1;\n",
      }),
    ).toEqual(
      [
        unused("src/routes/index.ts:2", "ROUTE"),
        sharedByOne("src/shared/helper.ts", "src", "src/routes"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const onlyReachableUsersCount = Task.make(
  "files that only use or dynamically import each other and that are not reached do not keep each other's exports alive",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": 'import { LIVE } from "./internal/live.ts";\nexport const MAIN = LIVE;\n',
        "src/internal/live.ts": 'import { HELP } from "./help.ts";\nexport const LIVE = HELP;\n',
        "src/internal/help.ts": "export const HELP = 1;\n",
        "src/dead/first.ts":
          'import { SECOND } from "./second.ts";\nexport const FIRST = SECOND;\n',
        "src/dead/second.ts":
          'import { FIRST } from "./first.ts";\nexport const SECOND = () => FIRST;\n',
        "src/lazy/one.ts": 'export const ONE = () => import("./two.ts");\n',
        "src/lazy/two.ts": 'export const TWO = () => import("./one.ts");\n',
      }),
    ).toEqual(
      [
        deadUsed("src/dead/first.ts:2", "FIRST", "src/dead/second.ts"),
        deadUsed("src/dead/second.ts:2", "SECOND", "src/dead/first.ts"),
        deadUsed("src/lazy/one.ts:1", "ONE", "src/lazy/two.ts"),
        deadUsed("src/lazy/two.ts:1", "TWO", "src/lazy/one.ts"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const bunBuildEntrypointsUseTheirFiles = Task.make(
  "a literal Bun.build entrypoint, resolved from the package root, uses every export of that file",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": "export const MAIN = 1;\n",
        "scripts/build.ts": [
          "export const BUILT = Bun.build({",
          '  entrypoints: ["apps/edge/worker.ts", "./apps/edge/page.ts"],',
          '  outdir: "dist",',
          "});",
          "",
        ].join("\n"),
        "apps/edge/worker.ts": "export default { fetch: () => 1 };\n",
        "apps/edge/page.ts": "export const PAGE = 1;\n",
        "apps/edge/unbuilt.ts": "export const UNBUILT = 1;\n",
      }),
    ).toEqual([unused("apps/edge/unbuilt.ts:1", "UNBUILT")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const ownFileProductionUseIsProductionUse = Task.make(
  "an export that production code in its own file uses is not TestOnlyExport when tests use it too",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts":
          'import { handle } from "./internal/service.ts";\nexport const MAIN = handle;\n',
        "src/internal/service.ts": [
          "export const permits = (count: number) => count > 0;",
          "export const handle = (count: number) => (permits(count) ? 1 : 0);",
          "export const tested = 1;",
          "",
        ].join("\n"),
        "tests/service.ts":
          'import { permits, tested } from "../src/internal/service.ts";\nexport const CHECKED = [permits, tested];\n',
      }),
    ).toEqual([testOnly("src/internal/service.ts:3", "tested")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const urlBuildEntriesAndConfigFilesAreExact = Task.make(
  "a Bun.build entry built inline from new URL is checked like any file, and only a named tool file such as vite.config.ts has its exports read from outside, so another *.config.ts is checked at the package root or nested unless new URL names it",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          "export const BUILT = Bun.build({",
          '  entrypoints: [new URL("./internal/run.ts", import.meta.url).pathname],',
          "});",
          'export const NAMED_CONFIG = new URL("./internal/app.config.ts", import.meta.url);',
          "",
        ].join("\n"),
        "src/internal/run.ts": "export const RUN = 1;\n",
        "app.config.ts": "export const ROOT = 1;\n",
        "src/feature/app.config.ts": "export const NESTED = 1;\n",
        "src/internal/app.config.ts": "export const NAMED = 1;\n",
      }),
    ).toEqual(
      [
        unused("app.config.ts:1", "ROOT"),
        unused("src/feature/app.config.ts:1", "NESTED"),
        unused("src/internal/run.ts:1", "RUN"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const shorthandAndRenamedBindingsResolveToTheirValues = Task.make(
  "a shorthand property uses the export it names, including in an exported default object, and a renamed destructured export is found by its binding name, not its property key",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import api from "./internal/api.ts";',
          'import { run } from "./internal/run.ts";',
          "export const MAIN = [api, run];",
          "",
        ].join("\n"),
        "src/internal/api.ts": [
          "export const get = () => 1;",
          "export const put = () => 2;",
          "export default { get, put };",
          "",
        ].join("\n"),
        "src/internal/run.ts": [
          "const source = { limit: 1, other: 2 };",
          "export const { limit: other, other: limit } = source;",
          "export const run = { limit, total: other };",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const exportMapKeysMatchLikeNode = Task.make(
  "an exports subpath is matched by its exact key or else the pattern with the longest prefix, so a more specific pattern exposes files that a broader null pattern hides",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "package.json":
          '{ "name": "placement", "type": "module", "exports": { ".": "./src/index.ts", "./*": null, "./public/*": "./src/public/*.ts", "./public/secret": null } }\n',
        "src/index.ts": "export const MAIN = 1;\n",
        "src/public/open.ts": "export const OPEN = 1;\n",
        "src/public/secret.ts": "export const SECRET = 1;\n",
      }),
    ).toEqual([unused("src/public/secret.ts:1", "SECRET")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const exportsKeysFollowNodeRules = Task.make(
  "an exports key with more than one * is not a pattern, and an exports object that mixes subpath and condition keys fails with PackageExportsMixKeys",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "package.json":
          '{ "name": "placement", "type": "module", "exports": { ".": "./src/index.ts", "./*/*": "./src/pairs/*/*.ts" } }\n',
        "src/index.ts": "export const MAIN = 1;\n",
        "src/pairs/a/b.ts": "export const PAIR = 1;\n",
      }),
    ).toEqual([unused("src/pairs/a/b.ts:1", "PAIR")]);
    const failure = yield* placementViolationsIn({
      "package.json":
        '{ "name": "placement", "type": "module", "exports": { ".": "./src/index.ts", "import": "./src/index.ts" } }\n',
      "src/index.ts": "export const MAIN = 1;\n",
    }).pipe(failureAsValue);
    expect(failure._tag).toBe("PackageExportsMixKeys");
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const filesInImportCyclesArePlacedLikeAnyOther = Task.make(
  "a file in an import cycle is reported like any other file, here as FileOutsideModuleLayout, and the cycle itself is left to the import/no-cycle lint rule",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { B } from "./sub/index.ts";',
          'import { D } from "./gamma/index.ts";',
          "export const MAIN = [B, D];",
          "",
        ].join("\n"),
        "src/a.ts": 'import { B } from "./sub/index.ts";\nexport const A = () => B;\n',
        "src/sub/index.ts": 'import { A } from "../a.ts";\nexport const B = () => A;\n',
        "src/gamma/index.ts": 'import { E } from "../delta/index.ts";\nexport const D = () => E;\n',
        "src/delta/index.ts": 'import { D } from "../gamma/index.ts";\nexport const E = () => D;\n',
      }),
    ).toEqual([outsideModuleLayout("src/a.ts", "src")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const workerPreloadsAreReached = Task.make(
  "a Worker preload named in a const options object or spread in from a parenthesized conditional options object is reached, so what it imports is used",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { fileURLToPath } from "node:url";',
          "const OPTIONS = {",
          '  preload: [new URL("./internal/named.ts", import.meta.url).href],',
          "};",
          'export const NAMED = new Worker(new URL("./internal/thread.ts", import.meta.url), OPTIONS);',
          "export const start = (empty: boolean) =>",
          '  new Worker(new URL("./internal/thread.ts", import.meta.url), {',
          "    ...(empty",
          "      ? {}",
          '      : { preload: [fileURLToPath(new URL("./internal/spread.ts", import.meta.url))] }),',
          "  });",
          "",
        ].join("\n"),
        "src/internal/thread.ts": "console.info(1);\n",
        "src/internal/named.ts":
          'import { NAMED_HELP } from "./help.ts";\nconsole.info(NAMED_HELP);\n',
        "src/internal/spread.ts":
          'import { SPREAD_HELP } from "./help.ts";\nconsole.info(SPREAD_HELP);\n',
        "src/internal/help.ts": "export const NAMED_HELP = 1;\nexport const SPREAD_HELP = 2;\n",
      }),
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const looseFilesInAModuleAreOutsideTheLayout = Task.make(
  "a used file directly in a module directory, or in a directory without an index.ts inside a module, is FileOutsideModuleLayout naming that module, while index files, declaration files, files in shared/ with two users pass, while a scripts/shared/ file used only directly in scripts/ belongs in scripts/internal/",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { FLAT_MODULE } from "./flat-module/index.ts";',
          'import { RULE } from "./rules/rule.ts";',
          'import { WORDS } from "./shared/words.ts";',
          'import { A } from "./only-shared/a.ts";',
          'import { RUNNER } from "./module-child/runner.ts";',
          'import { FLAT } from "./flat/a.ts";',
          'import { HELPER } from "./helper.ts";',
          'import { SPLIT } from "./split/index.ts";',
          "export const MAIN = [FLAT_MODULE, RULE, WORDS, A, RUNNER, FLAT, HELPER, ASSET, SPLIT];",
          "",
        ].join("\n"),
        "src/assets.d.ts": "declare const ASSET: number;\n",
        "src/helper.ts": "export const HELPER = 1;\n",
        "src/flat-module/index.ts":
          'import { INNER_HELPER } from "./helper.ts";\nexport const FLAT_MODULE = INNER_HELPER;\n',
        "src/flat-module/helper.ts": "export const INNER_HELPER = 1;\n",
        "src/rules/rule.ts":
          'import { WORDS } from "../shared/words.ts";\nexport const RULE = WORDS;\n',
        "src/shared/words.ts": "export const WORDS = 1;\n",
        "src/only-shared/a.ts": 'import { B } from "./shared/b.ts";\nexport const A = B;\n',
        "src/only-shared/shared/b.ts": "export const B = 1;\n",
        "src/module-child/runner.ts":
          'import { INNER } from "./inner/index.ts";\nexport const RUNNER = INNER;\n',
        "src/module-child/inner/index.ts": "export const INNER = 1;\n",
        "src/flat/a.ts": 'import { FLAT_B } from "./b.ts";\nexport const FLAT = FLAT_B;\n',
        "src/flat/b.ts": "export const FLAT_B = 1;\n",
        "src/split/index.ts": [
          'import { PART } from "./part/index.ts";',
          'import { BOTH } from "./both.ts";',
          "export const SPLIT = [PART, BOTH];",
          "",
        ].join("\n"),
        "src/split/both.ts": "export const BOTH = 1;\n",
        "src/split/part/index.ts":
          'import { BOTH } from "../both.ts";\nexport const PART = BOTH;\n',
        "scripts/ci.ts": 'import { TOOL } from "./shared/tool.ts";\nexport const CI = TOOL;\n',
        "scripts/shared/tool.ts": "export const TOOL = 1;\n",
      }),
    ).toEqual(
      [
        sharedByOne("scripts/shared/tool.ts", "scripts"),
        outsideModuleLayout("src/helper.ts", "src"),
        outsideModuleLayout("src/flat-module/helper.ts", "src/flat-module"),
        outsideModuleLayout("src/flat/a.ts", "src"),
        outsideModuleLayout("src/flat/b.ts", "src"),
        outsideModuleLayout("src/only-shared/a.ts", "src"),
        outsideModuleLayout("src/only-shared/shared/b.ts", "src"),
        outsideModuleLayout("src/module-child/runner.ts", "src"),
        outsideModuleLayout("src/rules/rule.ts", "src"),
        sharedByOne("src/shared/words.ts", "src"),
        outsideModuleLayout("src/split/both.ts", "src/split"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const looseFilesWithoutUsedExportsAreStillOutsideTheLayout = Task.make(
  "a file with no exports directly in a module directory, or in a directory without an index.ts inside a module, is still FileOutsideModuleLayout, a file nothing imports whose exports are unused is reported once, as UnusedExport, and declaration files pass",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import "./area/index.ts";',
          'import "./flat/side-effect.ts";',
          'import "./sides/side.ts";',
          "export const MAIN = 1;",
          "",
        ].join("\n"),
        "src/area/index.ts": 'import "./side-effect.ts";\n',
        "src/area/side-effect.ts": "const SIDE_EFFECT = 1;\n",
        "src/area/unused.ts": "export const UNUSED = 1;\n",
        "src/area/ambient.d.ts": "declare const AMBIENT: number;\n",
        "src/flat/side-effect.ts": "const FLAT_SIDE_EFFECT = 1;\n",
        "src/sides/side.ts": 'import "./inner/leaf.ts";\n',
        "src/sides/inner/leaf.ts": "const LEAF = 1;\n",
      }),
    ).toEqual(
      [
        outsideModuleLayout("src/area/side-effect.ts", "src/area"),
        outsideModuleLayout("src/flat/side-effect.ts", "src"),
        outsideModuleLayout("src/sides/side.ts", "src"),
        outsideModuleLayout("src/sides/inner/leaf.ts", "src"),
        unused("src/area/unused.ts:1", "UNUSED"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const sharedFilesNeedTwoUsers = Task.make(
  "a shared/ file needs two distinct parts of its parent as users: two child modules, or the module itself and one child, pass, one child or the module alone is SharedFileWithOneUser naming that one part, users through another file of the same shared/ count, a nested module's shared/ counts its own parts, and a shared/ file nothing or only tests use is reported once, as UnusedExport or TestOnlyExport",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { READ } from "./read/index.ts";',
          'import { WRITE } from "./write/index.ts";',
          'import { SELF } from "./shared/self.ts";',
          'import { WITH_CHILD } from "./shared/with-child.ts";',
          "export const MAIN = [READ, WRITE, SELF, WITH_CHILD];",
          "",
        ].join("\n"),
        "src/shared/two.ts": "export const TWO = 1;\n",
        "src/shared/one.ts": "export const ONE = 1;\n",
        "src/shared/self.ts": "export const SELF = 1;\n",
        "src/shared/with-child.ts": "export const WITH_CHILD = 1;\n",
        "src/shared/through.ts":
          'import { DEEP } from "./deep.ts";\nexport const THROUGH = DEEP;\n',
        "src/shared/deep.ts": "export const DEEP = 1;\n",
        "src/shared/nothing.ts": "export const NOTHING = 1;\n",
        "src/shared/relay.ts": 'import { INNER } from "./inner.ts";\nexport const RELAY = INNER;\n',
        "src/shared/inner.ts": "export const INNER = 1;\n",
        "src/shared/tested.ts": "export const TESTED = 1;\n",
        "src/read/index.ts": [
          'import { TWO } from "../shared/two.ts";',
          'import { ONE } from "../shared/one.ts";',
          'import { THROUGH } from "../shared/through.ts";',
          'import { WITH_CHILD } from "../shared/with-child.ts";',
          'import { RELAY } from "../shared/relay.ts";',
          'import { NESTED } from "./nested/index.ts";',
          "export const READ = [TWO, ONE, THROUGH, WITH_CHILD, RELAY, NESTED];",
          "",
        ].join("\n"),
        "src/read/nested/index.ts": [
          'import { CHILD } from "./child/index.ts";',
          'import { ALONE } from "./shared/alone.ts";',
          "export const NESTED = [CHILD, ALONE];",
          "",
        ].join("\n"),
        "src/read/nested/child/index.ts":
          'import { PAIR } from "../shared/pair.ts";\nexport const CHILD = PAIR;\n',
        "src/read/nested/shared/pair.ts":
          'import { ALONE } from "./alone.ts";\nexport const PAIR = ALONE;\n',
        "src/read/nested/shared/alone.ts": "export const ALONE = 1;\n",
        "src/write/index.ts": [
          'import { TWO } from "../shared/two.ts";',
          'import { THROUGH } from "../shared/through.ts";',
          "export const WRITE = [TWO, THROUGH];",
          "",
        ].join("\n"),
        "scripts/ci.ts":
          'import * as tested from "../tests/tested.ts";\nexport const CI = [tested];\n',
        "tests/tested.ts":
          'import { TESTED } from "../src/shared/tested.ts";\nexport const TESTS = TESTED;\n',
      }),
    ).toEqual(
      [
        sharedByOne("src/shared/one.ts", "src", "src/read"),
        sharedByOne("src/shared/relay.ts", "src", "src/read"),
        `${sharedByOne("src/shared/inner.ts", "src", "src/read")}, counting the users of src/shared/relay.ts`,
        sharedByOne("src/shared/self.ts", "src"),
        sharedByOne("src/read/nested/shared/pair.ts", "src/read/nested", "src/read/nested/child"),
        unused("src/shared/nothing.ts:1", "NOTHING"),
        testOnly("src/shared/tested.ts:1", "TESTED"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

const DECLARES_A_TEST = "export const PASSES = 1;\n";

export const everyTestIsImportedByAScript = Task.make(
  "a test that no script in scripts/ reaches through its imports is TestNotRun, while tests imported statically, by a literal import(), without their extension, through package.json imports, through tsconfig paths or by the package's own name pass, and a test imported only for its types is still TestNotRun",
  Effect.gen(function* () {
    const violations = yield* everyPlacementViolationIn({
      "package.json":
        '{ "name": "probe", "type": "module", "imports": { "#tests/*": "./tests/*" }, "exports": { "./tests/*": "./tests/*" } }\n',
      "tsconfig.json":
        '{ "compilerOptions": { "strict": true, "module": "Preserve", "moduleResolution": "Bundler", "allowImportingTsExtensions": true, "noEmit": true, "skipLibCheck": true, "types": ["bun"], "paths": { "@tests/*": ["./tests/*"] } }, "include": ["**/*.ts"] }\n',
      "scripts/ci.ts": [
        'import * as wired from "../tests/wired.ts";',
        'import * as bare from "../tests/bare";',
        'const late = await import("../tests/late.ts");',
        'import * as hashed from "#tests/hashed.ts";',
        'import * as aliased from "@tests/aliased.ts";',
        'import * as named from "probe/tests/named.ts";',
        'import type { PASSES } from "../tests/typed.ts";',
        'import { type PASSES as MIXED_TYPE, PASSES as MIXED } from "../tests/mixed.ts";',
        "export const RUN = [wired, bare, late, hashed, aliased, named, MIXED];",
        "export type Run = [typeof PASSES, MIXED_TYPE];",
        "",
      ].join("\n"),
      ...Object.fromEntries(
        ["typed", "mixed", "hashed", "aliased", "named", "wired", "bare", "late", "orphan"].map(
          (name) => [`tests/${name}.ts`, DECLARES_A_TEST],
        ),
      ),
      "scripts/shared/fixture.ts": "export const FIXTURE = 1;\n",
    });
    expect(
      taggedViolations(violations.filter((violation) => Schema.is(TestNotRun)(violation))),
    ).toEqual(
      ["orphan", "typed"].map(
        (name) =>
          `tests/${name}.ts: error TestNotRun: is a test that no file directly in scripts/ reaches through its imports`,
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const looseFilesUsedThroughSharedCountItsUsers = Task.make(
  "a loose file in a module whose only user is a file in the module's shared/ is FileOutsideModuleLayout whatever that file's users are, and a shared/ file that only the module itself uses is SharedFileWithOneUser",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { SPREAD } from "./shared/spread.ts";',
          'import { ALONE } from "./shared/alone.ts";',
          'import { PART } from "./part/index.ts";',
          "export const MAIN = [SPREAD, ALONE, PART];",
          "",
        ].join("\n"),
        "src/part/index.ts":
          'import { SPREAD } from "../shared/spread.ts";\nexport const PART = SPREAD;\n',
        "src/shared/spread.ts": 'import { WIDE } from "../wide.ts";\nexport const SPREAD = WIDE;\n',
        "src/shared/alone.ts":
          'import { NARROW } from "../narrow.ts";\nexport const ALONE = NARROW;\n',
        "src/wide.ts": "export const WIDE = 1;\n",
        "src/narrow.ts": "export const NARROW = 1;\n",
      }),
    ).toEqual(
      [
        outsideModuleLayout("src/wide.ts", "src"),
        outsideModuleLayout("src/narrow.ts", "src"),
        sharedByOne("src/shared/alone.ts", "src"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const eachCauseIsReportedOnce = Task.make(
  "a loose file nothing reaches is not FileOutsideModuleLayout",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": "export const MAIN = 1;\n",
        "src/cli.ts": "console.info(1);\n",
        "src/orphan.ts": "export const ORPHAN = 1;\n",
      }),
    ).toEqual([unused("src/orphan.ts:1", "ORPHAN")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const sharedFilesNameTheOnePartThatUsesThem = Task.make(
  "a shared/ file used only by one child module is SharedFileWithOneUser naming that child, counting users through the child's own shared/ as the child's",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { RUN } from "./main/index.ts";',
          "export const MAIN = RUN;",
          "",
        ].join("\n"),
        "src/main/index.ts": [
          'import { WORKERS } from "./workers/index.ts";',
          'import { OTHER } from "./other/index.ts";',
          "export const RUN = [WORKERS, OTHER];",
          "",
        ].join("\n"),
        "src/main/other/index.ts": "export const OTHER = 1;\n",
        "src/main/shared/state.ts": "export const STATE = 1;\n",
        "src/main/workers/index.ts": [
          'import { HANDLED } from "./shared/handle.ts";',
          'import { ONCE } from "./once/index.ts";',
          "export const WORKERS = [HANDLED, ONCE];",
          "",
        ].join("\n"),
        "src/main/workers/shared/handle.ts":
          'import { STATE } from "../../shared/state.ts";\nexport const HANDLED = STATE;\n',
        "src/main/workers/once/index.ts":
          'import { HANDLED } from "../shared/handle.ts";\nexport const ONCE = HANDLED;\n',
      }),
    ).toEqual([sharedByOne("src/main/shared/state.ts", "src/main", "src/main/workers")]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const directoriesWithoutIndexOutsideModulesKeepTheirLayout = Task.make(
  "outside any module, a file is not placed by where its users sit and a shared/ file whose users sit in its own scope passes, while inside a module a directory without an index.ts is FileOutsideModuleLayout",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "package.json":
          '{ "name": "placement", "type": "module", "main": "./tools/cli/index.ts" }\n',
        "tools/cli/index.ts": [
          'import { LOOSE } from "../loose.ts";',
          'import { PLAIN } from "./plain/a.ts";',
          "export const CLI = [LOOSE, PLAIN];",
          "",
        ].join("\n"),
        "tools/cli/plain/a.ts": "export const PLAIN = 1;\n",
        "tools/loose.ts": 'import { HELP } from "./shared/help.ts";\nexport const LOOSE = HELP;\n',
        "tools/shared/help.ts": "export const HELP = 1;\n",
      }),
    ).toEqual(
      [
        besideSubdirectories("tools/loose.ts"),
        outsideModuleLayout("tools/cli/plain/a.ts", "tools/cli"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const filesBesideSubdirectoriesOutsideModulesAreReported = Task.make(
  "outside every module, a file directly in a directory that has subdirectories holding code is FileBesideSubdirectories, while a shared/ file used only under one subdirectory passes, and a scripts/shared/ file used only directly in scripts/ belongs in scripts/internal/",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": "export const MAIN = 1;\n",
        "scripts/ci.ts": [
          'import { RUN } from "../tools/run.ts";',
          'import { TOOL } from "./shared/tool.ts";',
          "export const CI = [RUN, TOOL];",
          "",
        ].join("\n"),
        "scripts/shared/tool.ts": "export const TOOL = 1;\n",
        "tools/run.ts": [
          'import { HELP } from "./help.ts";',
          'import { MAKE } from "./gen/make.ts";',
          "export const RUN = [HELP, MAKE];",
          "",
        ].join("\n"),
        "tools/help.ts": "export const HELP = 1;\n",
        "tools/gen/make.ts":
          'import { FORMAT } from "../shared/format.ts";\nexport const MAKE = FORMAT;\n',
        "tools/shared/format.ts": "export const FORMAT = 1;\n",
      }),
    ).toEqual(
      [
        sharedByOne("scripts/shared/tool.ts", "scripts"),
        besideSubdirectories("tools/help.ts"),
        besideSubdirectories("tools/run.ts"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

const TOOLS_SOURCES = {
  "src/index.ts": "export const MAIN = 1;\n",
  "scripts/ci.ts": 'import { RUN } from "../tools/run.ts";\nexport const CI = RUN;\n',
  "tools/run.ts": ['import { MAKE } from "./gen/make.ts";', "export const RUN = MAKE;", ""].join(
    "\n",
  ),
  "tools/gen/make.ts": "export const MAKE = 1;\n",
};

export const aNestedPackageJsonIsPlacedByItsName = Task.make(
  'a directory whose package.json has no name, such as { "type": "module" }, or that holds a directory named package.json, is placed like one with no package.json, so a file in it beside subdirectories that hold code is FileBesideSubdirectories, while a package.json whose name is no string, such as { "name": 5 }, fails the check with PackageManifestUnreadable instead of counting as unnamed',
  Effect.gen(function* () {
    for (const manifest of ['{ "type": "module" }\n', '{ "sideEffects": false }\n']) {
      expect(
        yield* placementViolationsIn({ ...TOOLS_SOURCES, "tools/package.json": manifest }),
      ).toEqual([besideSubdirectories("tools/run.ts")]);
    }
    expect(
      yield* placementViolationsIn({ ...TOOLS_SOURCES, "tools/package.json/note.txt": "\n" }),
    ).toEqual([besideSubdirectories("tools/run.ts")]);
    const failure = yield* placementViolationsIn({
      ...TOOLS_SOURCES,
      "tools/package.json": '{ "name": 5 }\n',
    }).pipe(
      failureAsValue,
      Effect.map((error) => error._tag),
    );
    expect(failure).toBe("PackageManifestUnreadable");
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const subdivisionDependsOnSubdirectoriesAlone = Task.make(
  "whether a directory has subdirectories that hold code depends only on those subdirectories, not on a package.json among the paths it is given, since those paths already leave out every directory whose package.json has a string name",
  Effect.sync(() => {
    const isSubdivided = isSubdividedAmong([
      "tools/package.json",
      "tools/run.ts",
      "tools/gen/make.ts",
    ]);
    expect(isSubdivided("tools")).toBe(true);
  }),
);

export const anIndexInSharedDoesNotMakeAModule = Task.make(
  "an index.ts directly in shared/ or internal/ is left to IndexInInternalOrShared and does not make that directory a module, so the files beside it are placed as files of that shared/ or internal/",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { SHARED } from "./shared/index.ts";',
          'import { SPREAD } from "./shared/spread.ts";',
          'import { PART } from "./part/index.ts";',
          "export const MAIN = [SHARED, SPREAD, PART];",
          "",
        ].join("\n"),
        "src/shared/index.ts": "export const SHARED = 1;\n",
        "src/shared/spread.ts": "export const SPREAD = 1;\n",
        "src/part/index.ts":
          'import { SPREAD } from "../shared/spread.ts";\nexport const PART = SPREAD;\n',
      }),
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const anIndexNestedInInternalOrSharedMakesNoModule = Task.make(
  "an index.ts in a directory nested in an internal/ or shared/, at any depth, makes no module, so the files beside it are files nested in that internal/ or shared/, which are not placed",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": 'import { A } from "./a/index.ts";\nexport const MAIN = A;\n',
        "src/a/index.ts": [
          'import { SUB } from "./internal/sub/index.ts";',
          'import { WIDE } from "./shared/sub/index.ts";',
          'import { PART } from "./part/index.ts";',
          'import { DEEP } from "./internal/x/shared/y/index.ts";',
          "export const A = [SUB, WIDE, PART, DEEP];",
          "",
        ].join("\n"),
        "src/a/internal/sub/index.ts":
          'import { BESIDE } from "./beside.ts";\nexport const SUB = BESIDE;\n',
        "src/a/internal/sub/beside.ts": "export const BESIDE = 1;\n",
        "src/a/shared/sub/index.ts":
          'import { NEAR } from "./near.ts";\nexport const WIDE = NEAR;\n',
        "src/a/shared/sub/near.ts": "export const NEAR = 1;\n",
        "src/a/part/index.ts":
          'import { WIDE } from "../shared/sub/index.ts";\nexport const PART = WIDE;\n',
        "src/a/internal/x/shared/y/index.ts": "export const DEEP = 1;\n",
      }),
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const hiddenSourceDirectoriesSubdivideTheirParents = Task.make(
  "a hidden directory holding sources subdivides its parent just like a visible directory",
  Effect.gen(function* () {
    const violations = yield* placementViolationsIn({
      "src/index.ts": 'import { RUN } from "../tools/run.ts";\nexport const MAIN = RUN;\n',
      "tools/run.ts": 'import { STUB } from "./.generated/stub.ts";\nexport const RUN = STUB;\n',
      "tools/.generated/stub.ts":
        'import { DEEP } from "./nested/deep.ts";\nexport const STUB = DEEP;\n',
      "tools/.generated/nested/deep.ts": "export const DEEP = 1;\n",
    });
    expect(violations).toEqual([
      besideSubdirectories("tools/.generated/stub.ts"),
      besideSubdirectories("tools/run.ts"),
    ]);
    expect(isSubdividedAmong(["tools/.child/index.ts"])("tools")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const testNamedDirectoriesAreNeverSubdivided = Task.make(
  "a directory named tests does not count as holding a subdirectory of source files, even when it holds one, while __tests__ and test count like any other name",
  Effect.gen(function* () {
    const violations = yield* placementViolationsIn({
      "src/index.ts": 'import { CASE } from "./suite/tests/case.ts";\nexport const MAIN = CASE;\n',
      "src/suite/tests/case.ts":
        'import { DATA } from "./fixtures/data.ts";\nexport const CASE = DATA;\n',
      "src/suite/tests/fixtures/data.ts": "export const DATA = 1;\n",
    });
    expect(
      violations.filter((violation) => violation.includes("FileBesideSubdirectories")),
    ).toEqual([]);
    for (const name of ["__tests__", "test"]) {
      expect(isSubdividedAmong([`src/suite/${name}/fixtures/data.ts`])(`src/suite/${name}`)).toBe(
        true,
      );
    }
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const modulesInLibraryDirectoriesArePlacedLikeAnyModule = Task.make(
  "a module in a lib/ is a part of its parent, so a parent shared/ file used by two of them passes and one used by one of them is SharedFileWithOneUser naming it, while a file directly in a lib/ is FileOutsideModuleLayout naming the module that holds the lib/",
  Effect.gen(function* () {
    expect(
      yield* placementViolationsIn({
        "src/index.ts": [
          'import { RUN } from "./lib/tasks/index.ts";',
          'import { LOOSE } from "./lib/loose.ts";',
          "export const MAIN = [RUN, LOOSE];",
          "",
        ].join("\n"),
        "src/lib/loose.ts": "export const LOOSE = 1;\n",
        "src/lib/tasks/index.ts": [
          'import { LAYOUT } from "./lib/layout/index.ts";',
          'import { CHECK } from "./lib/check/index.ts";',
          "export const RUN = [LAYOUT, CHECK];",
          "",
        ].join("\n"),
        "src/lib/tasks/shared/both.ts": "export const BOTH = 1;\n",
        "src/lib/tasks/shared/one.ts": "export const ONE = 1;\n",
        "src/lib/tasks/lib/layout/index.ts": [
          'import { BOTH } from "../../shared/both.ts";',
          'import { ONE } from "../../shared/one.ts";',
          "export const LAYOUT = [BOTH, ONE];",
          "",
        ].join("\n"),
        "src/lib/tasks/lib/check/index.ts":
          'import { BOTH } from "../../shared/both.ts";\nexport const CHECK = BOTH;\n',
      }),
    ).toEqual(
      [
        outsideModuleLayout("src/lib/loose.ts", "src"),
        sharedByOne("src/lib/tasks/shared/one.ts", "src/lib/tasks", "src/lib/tasks/lib/layout"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);
