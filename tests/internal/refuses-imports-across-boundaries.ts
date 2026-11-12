import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Predicate, Array as Arrays, flow } from "effect";

import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const BOUNDARIES = `lintConfig({
  src: { cannotImport: ["src/generated"] },
  "src/worker-thread": { cannotImport: ["src/main-thread", "src/generated/b.ts"] },
  "src/main-thread": { cannotImport: ["src/worker-thread", "src/shared/secret.ts"] },
})`;

const SOURCES = {
  "src/main-thread/y.ts": 'import { Z } from "../shared/z.ts";\nexport const Y = Z;\n',
  "src/main-thread/own.ts": 'import { Y } from "./y.ts";\nexport const OWN = Y;\n',
  "src/main-thread/secret-reader.ts":
    'import { SECRET } from "../shared/secret.ts";\nexport const READ = SECRET;\n',
  "src/main-thread/generated-reader.ts":
    'import { B } from "../generated/b.ts";\nexport const READ = B;\n',
  "src/shared/z.ts": "export const Z = 1;\n",
  "src/shared/secret.ts": "export const SECRET = 1;\n",
  "src/generated/a.ts": 'import { B } from "./b.ts";\nexport const A = B;\n',
  "src/generated/b.ts": "export const B = 1;\n",
  "src/worker-thread/static.ts": 'import { Y } from "../main-thread/y.ts";\nexport const X = Y;\n',
  "src/worker-thread/typed.ts":
    'import type { Y } from "../main-thread/y.ts";\nexport type Typed = typeof Y;\n',
  "src/worker-thread/named-re-export.ts": 'export { Y } from "../main-thread/y.ts";\n',
  "src/worker-thread/star-re-export.ts": 'export * from "../main-thread/own.ts";\n',
  "src/worker-thread/dynamic.ts": [
    'export const literal = () => import("../main-thread/y.ts");',
    "export const template = () => import(`../main-thread/own.ts`);",
    "export const computed = (name: string) => import(name);",
    "",
  ].join("\n"),
  "src/worker-thread/alias.ts": 'import { Y } from "@main/y.ts";\nexport const ALIASED = Y;\n',
  "src/worker-thread/directory-index.ts":
    'import { INDEXED } from "../main-thread";\nexport const FROM_INDEX = INDEXED;\n',
  "src/main-thread/index.ts": "export const INDEXED = 1;\n",
  "src/worker-thread/tool-user.ts":
    'import { TOOL } from "../../scripts/tool.ts";\nexport const USED = TOOL;\n',
  "src/worker-thread/generated-reader.ts":
    'import { B } from "../generated/b.ts";\nexport const READ = B;\n',
  "src/worker-thread/shared-user.ts":
    'import { Z } from "../shared/z.ts";\nexport const SHARED = Z;\n',
  "src/worker-thread/type-position.ts":
    'export type Positioned = typeof import("../main-thread/y.ts").Y;\n',
  "src/main-thread/linked/leaf.ts": "export const LEAF = 1;\n",
  "src/worker-thread/through-link.ts":
    'import { LEAF } from "./link/leaf.ts";\nexport const LINKED = LEAF;\n',
  "src/main-thread/settings.json": '{ "mode": 1 }\n',
  "src/worker-thread/json-user.ts":
    'import settings from "../main-thread/settings.json";\nexport const MODE = settings.mode;\n',
  "src/main-thread/side-effect.ts": "const SIDE_EFFECT = 1;\n",
  "src/worker-thread/side-effect-user.ts": 'import "../main-thread/side-effect.ts";\n',
  "src/worker-thread/missing.ts":
    'export const MISSING = import.meta.resolve("./missing-file.ts");\n',
  "scripts/tool.ts": "export const TOOL = 1;\n",
};

const PROJECT_FIELDS = {
  compilerOptions: {
    strict: true,
    module: "Preserve",
    moduleResolution: "Bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["bun"],
    resolveJsonModule: true,
    paths: { "@main/*": ["./src/main-thread/*"] },
  },
} as const;

const isBoundaryViolation = (violation: { readonly _tag: string }) =>
  !Predicate.isTagged(violation, "ModuleInternalsImported") &&
  !Predicate.isTagged(violation, "PlainDirectoryImported");

const crossed = (location: string, imported: string, owner: string, target: string) =>
  `${location}: error CannotImportCrossed: imports ${imported}, and ${owner} cannot import ${target}`;

export const importsAcrossBoundariesAreRefused = Task.make({
  name: "static, type, re-exported, literal dynamic, aliased, directory-index, symlinked, JSON and side-effect script imports across a boundary are refused, unresolvable relative imports are reported, and overlapping bans add up",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(SOURCES, BOUNDARIES, PROJECT_FIELDS);
    yield* fileSystem.symlink(
      path.join(directory, "src/main-thread/linked"),
      path.join(directory, "src/worker-thread/link"),
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations.filter(isBoundaryViolation))),
      ),
    );
    const worker = (file: string, imported: string) =>
      crossed(file, imported, "src/worker-thread", "src/main-thread");
    expect(violations.toSorted()).toEqual(
      [
        crossed(
          "src/main-thread/generated-reader.ts:1",
          "src/generated/b.ts",
          "src",
          "src/generated",
        ),
        crossed(
          "src/main-thread/secret-reader.ts:1",
          "src/shared/secret.ts",
          "src/main-thread",
          "src/shared/secret.ts",
        ),
        worker("src/worker-thread/alias.ts:1", "src/main-thread/y.ts"),
        worker("src/worker-thread/dynamic.ts:2", "src/main-thread/own.ts"),
        worker("src/worker-thread/dynamic.ts:1", "src/main-thread/y.ts"),
        worker("src/worker-thread/directory-index.ts:1", "src/main-thread/index.ts"),
        worker("src/worker-thread/named-re-export.ts:1", "src/main-thread/y.ts"),
        worker("src/worker-thread/star-re-export.ts:1", "src/main-thread/own.ts"),
        worker("src/worker-thread/static.ts:1", "src/main-thread/y.ts"),
        crossed("src/worker-thread/tool-user.ts:1", "scripts/tool.ts", "src", "scripts"),
        crossed(
          "src/worker-thread/generated-reader.ts:1",
          "src/generated/b.ts",
          "src",
          "src/generated",
        ),
        crossed(
          "src/worker-thread/generated-reader.ts:1",
          "src/generated/b.ts",
          "src/worker-thread",
          "src/generated/b.ts",
        ),
        worker("src/worker-thread/type-position.ts:1", "src/main-thread/y.ts"),
        worker("src/worker-thread/through-link.ts:1", "src/main-thread/linked/leaf.ts"),
        worker("src/worker-thread/json-user.ts:1", "src/main-thread/settings.json"),
        worker("src/worker-thread/side-effect-user.ts:1", "src/main-thread/side-effect.ts"),
        "src/worker-thread/missing.ts:1: error ImportResolvesToNoFile: imports ./missing-file.ts, which resolves to no file",
        worker("src/worker-thread/typed.ts:1", "src/main-thread/y.ts"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const crossingTheBuiltInBanIsReportedOnce = Task.make({
  name: "a src/ file importing a file deep inside scripts/ is reported once, as the built-in CannotImportCrossed, not also as PlainDirectoryImported or for a src/ grant's cannotImport within scripts/",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "src/reader.ts":
          'import { HELPER } from "../scripts/shared/helper.ts";\nexport const READER = HELPER;\n',
        "scripts/shared/helper.ts": "export const HELPER = 1;\n",
      },
      'lintConfig({ src: { cannotImport: ["scripts/shared"] } })',
      PROJECT_FIELDS,
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations).toEqual([
      crossed("src/reader.ts:1", "scripts/shared/helper.ts", "src", "scripts"),
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const projectsWithoutBoundariesPass = Task.make({
  name: "apart from the built-in module and internal-directory rules and the built-in ban on src/ importing scripts/, a config without cannotImport reports only unresolvable relative imports, and imports that stay inside their own banned directory pass",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(SOURCES, "lintConfig({})", PROJECT_FIELDS);
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations.filter(isBoundaryViolation))),
      ),
    );
    expect(violations.toSorted()).toEqual([
      ...[["src/worker-thread/missing.ts:1", "./missing-file.ts"]].map(
        ([location, specifier]) =>
          `${location}: error ImportResolvesToNoFile: imports ${specifier}, which resolves to no file`,
      ),
      crossed("src/worker-thread/tool-user.ts:1", "scripts/tool.ts", "src", "scripts"),
    ]);
    const insideTarget = yield* makeProject(
      {
        "src/generated/a.ts": 'import { B } from "./b.ts";\nexport const A = B;\n',
        "src/generated/b.ts": "export const B = 1;\n",
      },
      'lintConfig({ src: { cannotImport: ["src/generated"] } })',
    );
    yield* findImportBoundaryViolations(insideTarget.tsconfigFile);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const sourceImportsOfDevOnlyPackagesAreRefused = Task.make({
  name: "a src/ file importing a package that package.json lists only in devDependencies is refused, while peer, optional and runtime dependencies and imports from scripts/ pass",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": yield* encodeJson({
        name: "checked",
        type: "module",
        dependencies: { "oxc-parser": "0.153.0" },
        devDependencies: {
          "@sshkeda/task": "0.26.0",
          "@types/bun": "1.4.3",
          effect: "4.0.5",
          typescript: "7.0.2",
        },
        peerDependencies: { effect: "^4.0.5" },
        optionalDependencies: { typescript: "7.0.2" },
        imports: { "#task": "@sshkeda/task" },
      }),
      "src/runner.ts": 'import { Task } from "@sshkeda/task";\nexport const RUN = Task.exec;\n',
      "src/errors.ts": 'export type Reported = typeof import("@sshkeda/task/errors");\n',
      "src/lazy.ts": 'export const load = () => import("@sshkeda/task");\n',
      "src/resolved.ts": 'export const RESOLVED = import.meta.resolve("@sshkeda/task");\n',
      "src/aliased.ts": 'import { task } from "#task";\nexport const ALIASED = task;\n',
      "src/peer.ts": 'import { Effect } from "effect";\nexport const PEER = Effect.void;\n',
      "src/optional.ts": 'import ts from "typescript";\nexport const OPTIONAL = ts;\n',
      "src/runtime.ts":
        'import { parseSync } from "oxc-parser";\nexport const PARSE = parseSync;\n',
      "src/bun.ts": 'import { file } from "bun";\nexport const FILE = file;\n',
      "scripts/tool.ts": 'import { Task } from "@sshkeda/task";\nexport const TOOL = Task.exec;\n',
      "tests/runs.ts": 'import { Task } from "@sshkeda/task";\nexport const RUNS = Task.make;\n',
    });
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual(
      [
        ["src/aliased.ts:1", "#task"],
        ["src/errors.ts:1", "@sshkeda/task/errors"],
        ["src/lazy.ts:1", "@sshkeda/task"],
        ["src/resolved.ts:1", "@sshkeda/task"],
        ["src/runner.ts:1", "@sshkeda/task"],
      ].map(
        ([location, specifier]) =>
          `${location}: error DevDependencyImported: imports ${specifier}, but package.json lists @sshkeda/task only in devDependencies, and src cannot import a dev dependency`,
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const localModulesNamedLikeDevOnlyPackagesPass = Task.make({
  name: "a src/ file importing a name that package.json lists only in devDependencies passes when tsconfig paths resolve that name to a file in the package",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": yield* encodeJson({
          name: "checked",
          type: "module",
          devDependencies: { "@sshkeda/task": "0.26.0" },
        }),
        "src/task.ts": "export const task = 1;\n",
        "src/runner.ts": 'import { Task } from "@sshkeda/task";\nexport const RUN = Task.make;\n',
      },
      "lintConfig({})",
      {
        compilerOptions: {
          ...PROJECT_FIELDS.compilerOptions,
          paths: { "@sshkeda/task": ["./src/task.ts"] },
        },
      },
    );
    yield* findImportBoundaryViolations(tsconfigFile);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const dependencyAliasesUseTheirManifestKeys = Task.make({
  name: "development and runtime npm aliases use their dependency keys instead of the installed package name",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": yield* encodeJson({
        name: "checked",
        type: "module",
        dependencies: { "runtime-alias": "npm:actual-lib@1.0.0" },
        devDependencies: {
          "@tools/dev-alias": "npm:actual-lib@1.0.0",
          "actual-lib": "1.0.0",
          "isolated-dev": "npm:only-lib@1.0.0",
        },
      }),
      ...Object.fromEntries(
        [
          ["runtime-alias", "actual-lib"],
          ["@tools/dev-alias", "actual-lib"],
          ["isolated-dev", "only-lib"],
        ].flatMap(([name, installedName]) => [
          [
            `node_modules/${name}/package.json`,
            `{ "name": "${installedName}", "type": "module", "exports": { ".": "./index.ts", "./extra": "./index.ts" } }`,
          ],
          [`node_modules/${name}/index.ts`, "export const VALUE = 1;\n"],
        ]),
      ),
      "src/runtime.ts": 'import { VALUE } from "runtime-alias";\nexport const RUNTIME = VALUE;\n',
      "src/isolated.ts": 'import { VALUE } from "isolated-dev";\nexport const ISOLATED = VALUE;\n',
      "src/development.ts":
        'import { VALUE } from "@tools/dev-alias";\nexport const DEVELOPMENT = VALUE;\n',
      "src/subpath.ts":
        'import { VALUE } from "@tools/dev-alias/extra";\nexport const SUBPATH = VALUE;\n',
      "scripts/tool.ts": 'import { VALUE } from "@tools/dev-alias";\nexport const TOOL = VALUE;\n',
    });
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual(
      [
        ["src/development.ts:1", "@tools/dev-alias", "@tools/dev-alias"],
        ["src/isolated.ts:1", "isolated-dev", "isolated-dev"],
        ["src/subpath.ts:1", "@tools/dev-alias/extra", "@tools/dev-alias"],
      ].map(
        ([location, specifier, dependency]) =>
          `${location}: error DevDependencyImported: imports ${specifier}, but package.json lists ${dependency} only in devDependencies, and src cannot import a dev dependency`,
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const sourceFilesAreCheckedTogether = Task.make({
  name: "the import-boundary check reads its source files at the same time instead of one after another, and finds the real path of a file many files import once",
  run: Effect.gen(function* () {
    const importers = ["src/first.ts", "src/second.ts", "src/third.ts"];
    const { directory, tsconfigFile } = yield* makeProject({
      ...Object.fromEntries(
        importers.map((importer) => [
          importer,
          'import { SHARED } from "./shared.ts";\nexport const IMPORTED = SHARED;\n',
        ]),
      ),
      "src/shared.ts": "export const SHARED = 1;\n",
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sharedFile = yield* fileSystem.realPath(path.join(directory, "src/shared.ts"));
    const lookups = { reading: 0, mostReadingAtOnce: 0, realPathsOfTheSharedFile: 0 };
    const readFileString: typeof fileSystem.readFileString = (file, encoding) =>
      file.endsWith(".ts")
        ? Effect.gen(function* () {
            lookups.reading += 1;
            lookups.mostReadingAtOnce = Math.max(lookups.mostReadingAtOnce, lookups.reading);
            yield* Effect.yieldNow;
            return yield* fileSystem.readFileString(file, encoding);
          }).pipe(Effect.ensuring(Effect.sync(() => (lookups.reading -= 1))))
        : fileSystem.readFileString(file, encoding);
    const realPath: typeof fileSystem.realPath = (file) =>
      fileSystem.realPath(file).pipe(
        Effect.tap((real) =>
          Effect.sync(() => {
            lookups.realPathsOfTheSharedFile += real === sharedFile ? 1 : 0;
          }),
        ),
      );
    yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.provideService(FileSystem.FileSystem, { ...fileSystem, readFileString, realPath }),
    );
    expect(lookups.mostReadingAtOnce).toBeGreaterThan(1);
    expect(lookups.realPathsOfTheSharedFile).toBeLessThan(importers.length);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});
