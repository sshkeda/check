import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";

import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import {
  ignoredFilesImportedIn,
  ignoredPackagePathsAmong,
} from "../../src/lib/tasks/shared/list-ignored-files-imported-by-source.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const VALUE = "export const VALUE = 1;\n";
const IMPORTS_THROUGH_THE_DEVELOPMENT_CONDITION = 2;
const LOADER_LINE = 2;
const LOADED_LINE = 3;
const DIRECT_LINE = 4;
const RESOLVED_LINE = 5;
const IMPORTED_LINE = 6;
const GIT_EXIT_CODE_OUTSIDE_A_REPOSITORY = 128;

const importing = (specifier: string) =>
  `import { VALUE as IMPORTED } from "${specifier}";\nexport const VALUE = IMPORTED;\n`;

const imports = (specifiers: readonly string[]) =>
  [
    ...specifiers.map(
      (specifier, index) => `import { VALUE as IMPORTED_${index} } from "${specifier}";`,
    ),
    `export const VALUE = [${specifiers.map((_specifier, index) => `IMPORTED_${index}`).join(", ")}];`,
    "",
  ].join("\n");

const SOURCES = {
  "package.json": '{ "name": "visibility", "type": "module" }\n',
  "src/index.ts": imports([
    "./rules/rule.ts",
    "./tasks/index.ts",
    "./tasks/runner.ts",
    "@hidden/hidden.ts",
  ]),
  "src/rules/rule.ts": imports([
    "../shared/words.ts",
    "../tasks/index.ts",
    "../tasks/inner/index.ts",
    "../../package.json",
  ]),
  "src/rules/private/detail.ts": VALUE,
  "src/shared/words.ts": VALUE,
  "src/tasks/index.ts": importing("./runner.ts"),
  "src/tasks/runner.ts": imports([
    "./inner/index.ts",
    "./inner/hidden.ts",
    "../rules/rule.ts",
    "../rules/private/detail.ts",
  ]),
  "src/tasks/inner/index.ts": importing("./hidden.ts"),
  "src/tasks/inner/hidden.ts": VALUE,
  "scripts/ci.ts": imports([
    "../tests/visibility.ts",
    "../tests/shared/helper.ts",
    "./shared/tool.ts",
    "../src/index.ts",
    "../src/rules/rule.ts",
  ]),
  "scripts/shared/tool.ts": VALUE,
  "tests/visibility.ts": imports([
    "../src/tasks/inner/hidden.ts",
    "./shared/helper.ts",
    "./other.ts",
  ]),
  "tests/other.ts": VALUE,
  "tests/shared/helper.ts": imports(["../other.ts", "../../src/rules/private/detail.ts"]),
  "packages/shared/src/index.ts": VALUE,
  "packages/shared/src/inner.ts": VALUE,
  "packages/shared/package.json":
    '{ "name": "@workspace/shared", "exports": { ".": { "types": "./src/index.ts", "default": "./dist/index.js" } } }\n',
  "apps/api/index.ts": VALUE,
  "apps/api/server.ts": VALUE,
  "apps/web/index.ts": imports([
    "@workspace/shared",
    "../../packages/shared/src/inner.ts",
    "../api/index.ts",
    "../api/server.ts",
  ]),
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
    paths: { "@hidden/*": ["./src/tasks/inner/*"] },
  },
} as const;

const moduleInternals = (location: string, importedPath: string, module: string) =>
  `${location}: error ModuleInternalsImported: imports ${importedPath}, inside module ${module}/, from outside it`;

const packageInternals = (location: string, importedPath: string, module: string) =>
  `${location}: error ModuleInternalsImported: imports ${importedPath}, inside package ${module}/, from outside it`;

const internalDirectory = (location: string, importedPath: string, directory: string) =>
  `${location}: error PlainDirectoryImported: imports ${importedPath}, inside ${directory}/, which only ${directory.split("/").slice(0, -1).join("/")}/ may import`;

const crossed = (line: number, importedPath: string) =>
  `apps/web/index.ts:${line}: error CannotImportCrossed: imports ${importedPath}, and apps cannot import packages/conditional/src`;

export const importsRespectModulesAndInternalDirectories = Task.make(
  "outside a module only its index is importable, at every enclosing module; an internal directory is importable only from its parent's subtree; any file imports a visible index, a package by name and package.json; tests import anything outside tests/, and imports of tests/ follow the same rules",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      SOURCES,
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    yield* fileSystem.makeDirectory(path.join(directory, "apps/web/node_modules/@workspace"), {
      recursive: true,
    });
    yield* fileSystem.symlink(
      path.join(directory, "packages/shared"),
      path.join(directory, "apps/web/node_modules/@workspace/shared"),
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual(
      [
        moduleInternals("src/index.ts:3", "src/tasks/runner.ts", "src/tasks"),
        moduleInternals("src/index.ts:4", "src/tasks/inner/hidden.ts", "src/tasks"),
        moduleInternals("src/rules/rule.ts:3", "src/tasks/inner/index.ts", "src/tasks"),
        moduleInternals("src/tasks/runner.ts:2", "src/tasks/inner/hidden.ts", "src/tasks/inner"),
        internalDirectory(
          "src/tasks/runner.ts:4",
          "src/rules/private/detail.ts",
          "src/rules/private",
        ),
        moduleInternals("scripts/ci.ts:5", "src/rules/rule.ts", "src"),
        internalDirectory("scripts/ci.ts:2", "tests/shared/helper.ts", "tests/shared"),
        packageInternals("apps/web/index.ts:2", "packages/shared/src/inner.ts", "packages/shared"),
        moduleInternals("apps/web/index.ts:4", "apps/api/server.ts", "apps/api"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const cannotImportAddsLimitsOnTopOfVisibility = Task.make(
  "cannotImport refuses an import the module rules allow",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "src/index.ts": importing("./store/store.ts"),
        "src/store/store.ts": VALUE,
      },
      'lintConfig({ "src/index.ts": { cannotImport: ["src/store/store.ts"] } })',
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations).toEqual([
      "src/index.ts:1: error CannotImportCrossed: imports src/store/store.ts, and src/index.ts cannot import src/store/store.ts",
    ]);
  }).pipe(Effect.scoped),
);

const violationsOf = (tsconfigFile: string) =>
  findImportBoundaryViolations(tsconfigFile).pipe(
    Effect.as(new Array<string>()),
    Effect.catchTag("ImportBoundariesCrossed", (failure) =>
      Effect.succeed(taggedViolations(failure.violations)),
    ),
  );

const REACH_SOURCES = {
  "src/index.ts": importing("./feature/hidden.ts"),
  "src/feature/index.ts": VALUE,
  "src/feature/hidden.ts": VALUE,
  "src/shared/required.ts":
    'const { VALUE: HIDDEN } = require("../feature/hidden.ts");\nexport const VALUE = HIDDEN;\n',
};

const REACH_VIOLATIONS = [
  moduleInternals("src/index.ts:1", "src/feature/hidden.ts", "src/feature"),
  moduleInternals("src/shared/required.ts:1", "src/feature/hidden.ts", "src/feature"),
];

export const symlinkedCheckoutsKeepTheirBoundaries = Task.make(
  "a project reached through a symlinked directory reports the same module violations, require() calls included, as its real path",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(REACH_SOURCES);
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(REACH_VIOLATIONS);
    const linkDirectory = yield* fileSystem.makeTempDirectoryScoped();
    const linked = path.join(linkDirectory, "linked");
    yield* fileSystem.symlink(directory, linked);
    expect((yield* violationsOf(path.join(linked, "tsconfig.json"))).toSorted()).toEqual(
      REACH_VIOLATIONS,
    );
  }).pipe(Effect.scoped),
);

export const relativeImportsLeavingThePackageAreRefused = Task.make(
  "a relative or tsconfig-aliased import that resolves outside the package is ImportOutsidePackage, while installed packages and packages imported by name pass",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outsideDirectory = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped(),
    );
    const outsideFile = path.join(outsideDirectory, "outside.ts");
    yield* fileSystem.writeFileString(outsideFile, VALUE);
    const { directory, tsconfigFile } = yield* makeProject({
      "src/index.ts": 'import { Effect } from "effect";\nexport const VALUE = Effect.void;\n',
      "src/shared/escape.ts": VALUE,
    });
    const source = path.join(directory, "src/shared/escape.ts");
    const specifier = path.relative(path.dirname(source), outsideFile);
    yield* fileSystem.writeFileString(source, importing(specifier));
    const outside = (location: string, imported: string) =>
      `${location}: error ImportOutsidePackage: imports ${imported}, which resolves to ${outsideFile} outside the package`;
    expect(yield* violationsOf(tsconfigFile)).toEqual([
      outside("src/shared/escape.ts:1", specifier),
    ]);
    const aliased = yield* makeProject(
      {
        "src/index.ts": importing("@outside/outside.ts"),
      },
      "lintConfig({})",
      {
        compilerOptions: {
          ...PROJECT_FIELDS.compilerOptions,
          paths: { "@outside/*": [`${outsideDirectory}/*`] },
        },
      },
    );
    expect(yield* violationsOf(aliased.tsconfigFile)).toEqual([
      outside("src/index.ts:1", "@outside/outside.ts"),
    ]);
  }).pipe(Effect.scoped),
);

export const packageImportsResolveThroughConditions = Task.make(
  "package imports resolve through the bun condition and the tsconfig's customConditions",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "apps/web/index.ts": [
          'import { VALUE as BUN } from "@workspace/conditional";',
          'import { VALUE as DEVELOPMENT } from "@workspace/conditional/development";',
          "export const VALUE = [BUN, DEVELOPMENT];",
          "",
        ].join("\n"),
        "packages/conditional/src/bun.ts": VALUE,
        "packages/conditional/src/development.ts": VALUE,
        "packages/conditional/package.json":
          '{ "name": "@workspace/conditional", "exports": { ".": { "bun": "./src/bun.ts", "default": "./dist/index.js" }, "./development": { "development": "./src/development.ts", "default": "./dist/development.js" } } }\n',
      },
      'lintConfig({ apps: { cannotImport: ["packages/conditional/src"] } })',
      { compilerOptions: { ...PROJECT_FIELDS.compilerOptions, customConditions: ["development"] } },
    );
    yield* fileSystem.makeDirectory(path.join(directory, "apps/web/node_modules/@workspace"), {
      recursive: true,
    });
    yield* fileSystem.symlink(
      path.join(directory, "packages/conditional"),
      path.join(directory, "apps/web/node_modules/@workspace/conditional"),
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual([
      crossed(1, "packages/conditional/src/bun.ts"),
      crossed(IMPORTS_THROUGH_THE_DEVELOPMENT_CONDITION, "packages/conditional/src/development.ts"),
    ]);
  }).pipe(Effect.scoped),
);

export const packageNamesReachOnlyPublicEntries = Task.make(
  "a package imported by name passes only through its public entries: any subpath of a package with an exports map, and only the bare name of one without; template-literal imports are followed too",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "apps/web/index.ts": [
          'import { VALUE as MAPPED } from "@workspace/mapped/inner";',
          'import { VALUE as LOOSE } from "@workspace/loose";',
          'import { VALUE as DEEP } from "@workspace/loose/src/deep.ts";',
          "export const lazy = () => import(`../api/server.ts`);",
          "export const VALUE = [MAPPED, LOOSE, DEEP];",
          "",
        ].join("\n"),
        "apps/api/index.ts": VALUE,
        "apps/api/server.ts": VALUE,
        "packages/mapped/package.json":
          '{ "name": "@workspace/mapped", "exports": { "./inner": "./src/inner.ts" } }\n',
        "packages/mapped/src/inner.ts": VALUE,
        "packages/loose/package.json": '{ "name": "@workspace/loose", "main": "./index.ts" }\n',
        "packages/loose/index.ts": VALUE,
        "packages/loose/src/deep.ts": VALUE,
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    yield* fileSystem.makeDirectory(path.join(directory, "apps/web/node_modules/@workspace"), {
      recursive: true,
    });
    for (const name of ["mapped", "loose"]) {
      yield* fileSystem.symlink(
        path.join(directory, "packages", name),
        path.join(directory, "apps/web/node_modules/@workspace", name),
      );
    }
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        packageInternals("apps/web/index.ts:3", "packages/loose/src/deep.ts", "packages/loose"),
        moduleInternals("apps/web/index.ts:4", "apps/api/server.ts", "apps/api"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const subpathImportsReachPackagesThroughTheirTargets = Task.make(
  "a # subpath import whose target names another package passes through that package's public entries as the target would, so it may reach an exports entry but not a file of a package without an exports map",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "apps/web/package.json":
          '{ "imports": { "#mapped": "@workspace/mapped/inner", "#deep": "@workspace/loose/src/deep.ts", "#workspace/*": { "browser": "./browser/*.ts", "node": "@workspace/mapped/*" } } }\n',
        "apps/web/index.ts": imports(["#mapped", "#deep", "#workspace/inner"]),
        "packages/mapped/package.json":
          '{ "name": "@workspace/mapped", "exports": { "./inner": "./src/inner.ts" } }\n',
        "packages/mapped/src/inner.ts": VALUE,
        "packages/loose/package.json": '{ "name": "@workspace/loose", "main": "./index.ts" }\n',
        "packages/loose/index.ts": VALUE,
        "packages/loose/src/deep.ts": VALUE,
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    yield* fileSystem.makeDirectory(path.join(directory, "apps/web/node_modules/@workspace"), {
      recursive: true,
    });
    for (const name of ["mapped", "loose"]) {
      yield* fileSystem.symlink(
        path.join(directory, "packages", name),
        path.join(directory, "apps/web/node_modules/@workspace", name),
      );
    }
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual([
      packageInternals("apps/web/index.ts:2", "packages/loose/src/deep.ts", "packages/loose"),
    ]);
  }).pipe(Effect.scoped),
);

export const filesOutsideTheProgramRespectBoundaries = Task.make(
  "tracked .js and .d.ts files and files outside the tsconfig include are held to the same import boundaries",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        "src/tasks/index.ts": importing("./runner.ts"),
        "src/tasks/runner.ts": VALUE,
        "src/legacy/old.js": importing("../tasks/runner.ts"),
        "src/types/globals.d.ts": 'import type { VALUE } from "../tasks/runner.ts";\n',
        "tools/generate.ts": importing("../src/tasks/runner.ts"),
      },
      "lintConfig({})",
      { include: ["src/**/*.ts"] },
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual(
      [
        moduleInternals("src/legacy/old.js:1", "src/tasks/runner.ts", "src/tasks"),
        moduleInternals("src/types/globals.d.ts:1", "src/tasks/runner.ts", "src/tasks"),
        moduleInternals("tools/generate.ts:1", "src/tasks/runner.ts", "src/tasks"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const selfReferencesAreInternalImports = Task.make(
  "importing your own package by name reaches the same files as a relative path, so module boundaries still apply",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json":
          '{ "name": "selfy", "type": "module", "exports": { ".": "./src/index.ts", "./*": "./src/*" } }\n',
        "src/index.ts": importing("./feature/index.ts"),
        "src/feature/index.ts": importing("./hidden.ts"),
        "src/feature/hidden.ts": VALUE,
        "src/reader.ts": importing("selfy/feature/hidden.ts"),
        "scripts/build.ts": importing("selfy"),
      },
      "lintConfig({})",
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations).toEqual([
      moduleInternals("src/reader.ts:1", "src/feature/hidden.ts", "src/feature"),
    ]);
  }).pipe(Effect.scoped),
);

export const everyLoaderRespectsBoundaries = Task.make(
  "createRequire, import.meta.resolve and template literal imports are held to the same boundaries as import",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        "src/tasks/index.ts": importing("./runner.ts"),
        "src/tasks/runner.ts": VALUE,
        "src/loaders.ts": [
          'import { createRequire } from "node:module";',
          "const load = createRequire(import.meta.url);",
          'export const LOADED = load("./tasks/runner.ts");',
          'export const DIRECT = createRequire(import.meta.url)("./tasks/runner.ts");',
          'export const RESOLVED = import.meta.resolve("./tasks/runner.ts");',
          "export const IMPORTED = import(`./tasks/runner.ts`);",
          "",
        ].join("\n"),
      },
      "lintConfig({})",
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual(
      [
        ...[LOADED_LINE, DIRECT_LINE, RESOLVED_LINE, IMPORTED_LINE].map((line) =>
          moduleInternals(`src/loaders.ts:${line}`, "src/tasks/runner.ts", "src/tasks"),
        ),
        ...[LOADER_LINE, DIRECT_LINE].map(
          (line) =>
            `src/loaders.ts:${line}: error ModuleUrlPassedToFunction: passes import.meta.url to createRequire`,
        ),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const symlinkedDirectoriesAreCheckedOnce = Task.make(
  "a directory reached through a symbolic link is checked at its real path, once",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        "src/worker/index.ts": importing("./hidden.ts"),
        "src/worker/hidden.ts": VALUE,
        "src/reader.ts": importing("./alias/hidden.ts"),
      },
      "lintConfig({})",
    );
    yield* fileSystem.symlink(
      path.join(directory, "src/worker"),
      path.join(directory, "src/alias"),
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations).toEqual([
      moduleInternals("src/reader.ts:1", "src/worker/hidden.ts", "src/worker"),
    ]);
  }).pipe(Effect.scoped),
);

export const caseOnlyMismatchesAreNamed = Task.make(
  "a module URL whose path differs from the file only in letter case is ImportCaseMismatch on a case-insensitive file system and resolves to no file on a case-sensitive one, while a static import of a file in the TS program is left to bun check, which reports it as TS1261 (wrong case of an included file), TS1149 (two casings) or TS2307 (missing)",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        "src/feature/index.ts": importing("./hidden.ts"),
        "src/feature/hidden.ts": VALUE,
        "src/reader.ts": [
          'import { VALUE as IMPORTED } from "./Feature/index.ts";',
          'export const LATE = import("./Feature/index.ts");',
          "export const VALUE = IMPORTED;",
          'export const RESOLVED = import.meta.resolve("./Feature/index.ts");',
          "",
        ].join("\n"),
      },
      "lintConfig({})",
    );
    const caseInsensitive = yield* fileSystem.exists(path.join(directory, "src/FEATURE/index.ts"));
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations).toEqual([
      caseInsensitive
        ? "src/reader.ts:4: error ImportCaseMismatch: imports ./Feature/index.ts, which differs only in letter case from src/feature/index.ts"
        : "src/reader.ts:4: error ImportResolvesToNoFile: imports ./Feature/index.ts, which resolves to no file",
    ]);
  }).pipe(Effect.scoped),
);

export const missingIgnoredFilesAreNamed = Task.make(
  "an import of a missing file that git ignores, such as build output, says so instead of only that it resolves to no file, a module URL to a missing file resolves to no file, and a static import of one is left to bun check, which reports it as TS2307",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        ".gitignore": "node_modules\n.generated/\n",
        "src/page.ts": 'import page from "../.generated/page.txt";\nexport const PAGE = page;\n',
        "src/other.ts": `${importing("./absent.ts")}export const MISSING = new URL("./missing.ts", import.meta.url);\n`,
      },
      "lintConfig({})",
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual([
      "src/other.ts:3: error ImportResolvesToNoFile: imports ./missing.ts, which resolves to no file",
      "src/page.ts:1: error ImportOfMissingIgnoredFile: imports ../.generated/page.txt, but .generated/page.txt does not exist and is gitignored",
    ]);
  }).pipe(Effect.scoped),
);

export const filesOutsideTheProjectStillReportBrokenImports = Task.make(
  "a static import, export from or literal import() of a missing or wrong-case file is still reported in a file outside tsconfig include, because bun check never type-checks that file, and an index's export from a missing file is reported here once, since no-re-exports leaves it alone, while a bare specifier that resolves to no file, such as a missing package, a type-only or try/catch-guarded import of one, a subpath a package's exports block or an unknown node: or bun: module, is left to the type check",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        "src/index.ts": VALUE,
        "tools/helper.ts": VALUE,
        "src/bare.ts": importing("missing-package-xyz"),
        "tools/index.ts": 'export { VALUE } from "./internal/missing.ts";\n',
        "tools/bare/index.ts": 'export { VALUE } from "missing-package-xyz";\n',
        "tools/blocked/index.ts": 'export { VALUE } from "effect/not-a-subpath";\n',
        "tools/built-ins.ts": [
          'import { readFileSync } from "node:fs";',
          'import { test } from "bun:test";',
          'import { Database } from "bun:sqlite";',
          'import { nope } from "node:nope";',
          'import { other } from "bun:nope";',
          "export const VALUE = [readFileSync, test, Database, nope, other];",
          "",
        ].join("\n"),
        "tools/optional.ts": [
          'import type { Shape } from "missing-types-xyz";',
          "export const load = (): Shape | undefined => {",
          "  try {",
          '    return require("optional-package-xyz");',
          "  } catch {",
          "    return undefined;",
          "  }",
          "};",
          "",
        ].join("\n"),
        "tools/orphan.ts": [
          'import { VALUE as CASED } from "./Helper.ts";',
          'import { VALUE as ABSENT } from "./absent.ts";',
          'export const LATE = import("./missing.ts");',
          "export const VALUE = [CASED, ABSENT];",
          "",
        ].join("\n"),
      },
      "lintConfig({})",
      { include: ["src/**/*.ts"] },
    );
    const caseInsensitive = yield* fileSystem.exists(path.join(directory, "tools/HELPER.ts"));
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual([
      "tools/index.ts:1: error ImportResolvesToNoFile: imports ./internal/missing.ts, which resolves to no file",
      caseInsensitive
        ? "tools/orphan.ts:1: error ImportCaseMismatch: imports ./Helper.ts, which differs only in letter case from tools/helper.ts"
        : "tools/orphan.ts:1: error ImportResolvesToNoFile: imports ./Helper.ts, which resolves to no file",
      "tools/orphan.ts:2: error ImportResolvesToNoFile: imports ./absent.ts, which resolves to no file",
      "tools/orphan.ts:3: error ImportResolvesToNoFile: imports ./missing.ts, which resolves to no file",
    ]);
  }).pipe(Effect.scoped),
);

export const programFilesImportingExcludedFilesInTheWrongCaseAreReported = Task.make(
  "a file in the TS program that imports a file outside tsconfig include in the wrong letter case is ImportCaseMismatch on a case-insensitive file system, because bun check only reports case for targets in the program",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        "src/index.ts": [
          'import { VALUE as CASED } from "../tools/Helper.ts";',
          "export const VALUE = CASED;",
          "",
        ].join("\n"),
        "tools/helper.ts": VALUE,
      },
      "lintConfig({})",
      { include: ["src/**/*.ts"] },
    );
    const caseInsensitive = yield* fileSystem.exists(path.join(directory, "tools/HELPER.ts"));
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations).toEqual(
      caseInsensitive
        ? [
            "src/index.ts:1: error ImportCaseMismatch: imports ../tools/Helper.ts, which differs only in letter case from tools/helper.ts",
          ]
        : [],
    );
  }).pipe(Effect.scoped),
);

export const ignoredPathsAreListedVerbatim = Task.make(
  "ignored paths with a space, a newline or unicode are listed exactly as written, and unignored paths are left out",
  Effect.gen(function* () {
    const awkwardNames = ["with space.txt", "line\nbreak.txt", "caf\u00E9-\u65E5\u672C.txt"];
    const { directory } = yield* makeProject({
      "package.json": '{ "name": "visibility", "type": "module" }\n',
      ".gitignore": "node_modules\n*.txt\n",
      "kept.ts": "export const KEPT = 1;\n",
    });
    const ignored = yield* ignoredPackagePathsAmong([...awkwardNames, "kept.ts"], directory);
    expect(ignored.toSorted()).toEqual(awkwardNames.toSorted());
  }).pipe(Effect.scoped),
);

export const checkIgnoreFailuresOtherThanNothingIgnoredSurface = Task.make(
  "a git failure other than the nothing-ignored exit, such as running outside a repository, is a CommandFailed with its exit code",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const outsideRepository = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped(),
    );
    const exitCode = yield* ignoredPackagePathsAmong(["a.txt"], outsideRepository).pipe(
      Effect.as(0),
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.code)),
    );
    expect(exitCode).toBe(GIT_EXIT_CODE_OUTSIDE_A_REPOSITORY);
  }).pipe(Effect.scoped),
);

export const ignoredDirectoriesNamedByUrlAreSkipped = Task.make(
  "an ignored directory named by new URL is no imported file and is skipped, while an ignored file imported next to it is still listed",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": '{ "name": "visibility", "type": "module" }\n',
      ".gitignore": "node_modules\ngenerated/\nbuilt.txt\n",
      "generated/data.txt": "data\n",
      "built.txt": "built\n",
      "src/page.ts":
        'import built from "../built.txt";\nexport const DIRECTORY = new URL("../generated", import.meta.url);\nexport const BUILT = built;\n',
    });
    expect(yield* ignoredFilesImportedIn(tsconfigFile)).toEqual(["built.txt"]);
  }).pipe(Effect.scoped),
);

export const theNewUrlOfThePackageRootDoesNotBreakListing = Task.make(
  "new URL('../') in src names the package root, which is no ignored path, and an ignored file imported next to it is still listed",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": '{ "name": "visibility", "type": "module" }\n',
      ".gitignore": "node_modules\nbuilt.txt\n",
      "built.txt": "built\n",
      "src/page.ts":
        'import built from "../built.txt";\nexport const ROOT = new URL("../", import.meta.url);\nexport const BUILT = built;\n',
    });
    expect(yield* ignoredFilesImportedIn(tsconfigFile)).toEqual(["built.txt"]);
  }).pipe(Effect.scoped),
);

export const noIgnoredImportedPathListsNothing = Task.make(
  "when no imported path is ignored, git check-ignore exits 1 and no file is listed",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": '{ "name": "visibility", "type": "module" }\n',
      ".gitignore": "node_modules\n",
      "kept.ts": "export const KEPT = 1;\n",
      "src/page.ts": 'import { KEPT } from "../kept.ts";\nexport const VALUE = KEPT;\n',
    });
    expect(yield* ignoredFilesImportedIn(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped),
);

export const queriesAndFragmentsNameNoPartOfTheFile = Task.make(
  "an import's ?query and a new URL's ?query or #fragment name no part of the file, so an ignored file reached that way is listed",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": '{ "name": "visibility", "type": "module" }\n',
      ".gitignore": "node_modules\nbuilt.txt\ngenerated.txt\n",
      "built.txt": "built\n",
      "generated.txt": "generated\n",
      "src/logo.txt": "logo\n",
      "src/raw-imports.d.ts":
        'declare module "*?raw" {\n  const text: string;\n  export default text;\n}\n',
      "src/page.ts": [
        'import built from "../built.txt?raw";',
        'export const LOGO = new URL("./logo.txt?v=2", import.meta.url);',
        'export const GENERATED = new URL("../generated.txt#top", import.meta.url);',
        "export const BUILT = built;",
        "",
      ].join("\n"),
    });
    expect(yield* ignoredFilesImportedIn(tsconfigFile)).toEqual(["built.txt", "generated.txt"]);
  }).pipe(Effect.scoped),
);

export const importsReadAQueryButNoFragment = Task.make(
  "a ?raw import of a file inside a module from outside it is ModuleInternalsImported, naming the file without the query, and an import reads # as part of the file name, as Bun does",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": '{ "name": "visibility", "type": "module" }\n',
      "src/ui/index.ts": VALUE,
      "src/ui/notes.txt": "notes\n",
      "src/ui/c.ts": VALUE,
      "src/ui/c#.ts": VALUE,
      "src/raw-imports.d.ts":
        'declare module "*?raw" {\n  const text: string;\n  export default text;\n}\n',
      "src/reader.ts": 'import notes from "./ui/notes.txt?raw";\nexport const NOTES = notes;\n',
      "src/sharp-reader.ts": importing("./ui/c#.ts"),
    });
    expect(yield* violationsOf(tsconfigFile)).toEqual([
      "src/reader.ts:1: error ModuleInternalsImported: imports src/ui/notes.txt, inside module src/ui/, from outside it",
      "src/sharp-reader.ts:1: error ModuleInternalsImported: imports src/ui/c#.ts, inside module src/ui/, from outside it",
    ]);
  }).pipe(Effect.scoped),
);

export const queriedImportsAreCheckedAsTheirFiles = Task.make(
  "an import with a ?query is checked as the file it names: a missing ignored file is ImportOfMissingIgnoredFile, import.meta.resolve of a module's internals is ModuleInternalsImported, a wrong-case file is ImportCaseMismatch where the file system allows it, and a package's bare name passes",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outsideDirectory = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped(),
    );
    yield* fileSystem.writeFileString(
      path.join(outsideDirectory, "package.json"),
      '{ "name": "@workspace/loose", "main": "./index.ts" }\n',
    );
    yield* fileSystem.writeFileString(path.join(outsideDirectory, "index.ts"), VALUE);
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        ".gitignore": "node_modules\nbuilt.txt\n",
        "src/ui/index.ts": VALUE,
        "src/ui/internal.ts": VALUE,
        "tools/helper.txt": "helper\n",
        "src/raw-imports.d.ts":
          'declare module "*?raw" {\n  const text: string;\n  export default text;\n}\n',
        "src/page.ts": [
          'import built from "../built.txt?raw";',
          'import helper from "../tools/Helper.txt?raw";',
          'import loose from "@workspace/loose?raw";',
          'export const RESOLVED = import.meta.resolve("./ui/internal.ts?raw");',
          "export const VALUE = [built, helper, loose];",
          "",
        ].join("\n"),
      },
      "lintConfig({})",
      { include: ["src/**/*.ts"] },
    );
    yield* fileSystem.makeDirectory(path.join(directory, "node_modules/@workspace"), {
      recursive: true,
    });
    yield* fileSystem.symlink(
      outsideDirectory,
      path.join(directory, "node_modules/@workspace/loose"),
    );
    const caseInsensitive = yield* fileSystem.exists(path.join(directory, "tools/HELPER.txt"));
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        "src/page.ts:1: error ImportOfMissingIgnoredFile: imports ../built.txt, but built.txt does not exist and is gitignored",
        ...(caseInsensitive
          ? [
              "src/page.ts:2: error ImportCaseMismatch: imports ../tools/Helper.txt, which differs only in letter case from tools/helper.txt",
            ]
          : []),
        moduleInternals("src/page.ts:4", "src/ui/internal.ts", "src/ui"),
      ].toSorted(),
    );
    expect(yield* ignoredFilesImportedIn(tsconfigFile)).toEqual(["built.txt"]);
  }).pipe(Effect.scoped),
);

export const resolvedSpecifiersFollowTheRealFiles = Task.make(
  "a resolved .js specifier whose .ts file differs in letter case is ImportCaseMismatch where the file system allows it",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "visibility", "type": "module" }\n',
        "src/ui/index.tsx": VALUE,
        "src/ui/hidden.ts": VALUE,
        "src/parts/value.ts": VALUE,
        "src/reader.ts": importing("./ui/hidden.ts"),
        "src/cased.ts": 'export const CASED = import.meta.resolve("./parts/Value.js");\n',
      },
      "lintConfig({})",
      { include: ["**/*.ts", "**/*.tsx"] },
    );
    const caseInsensitive = yield* fileSystem.exists(path.join(directory, "src/PARTS/value.ts"));
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations.toSorted()).toEqual(
      [
        caseInsensitive
          ? "src/cased.ts:1: error ImportCaseMismatch: imports ./parts/Value.js, which differs only in letter case from src/parts/value.ts"
          : "src/cased.ts:1: error ImportResolvesToNoFile: imports ./parts/Value.js, which resolves to no file",
        "src/reader.ts:1: error ModuleInternalsImported: imports src/ui/hidden.ts, inside module src/ui/, from outside it",
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const internalDirectoryImportsNameTheOutermostHiddenDirectory = Task.make(
  "an internal directory import names the outermost directory around the imported file whose parent does not hold the importer, under src/, scripts/ and any other top-level directory",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "ancestors", "type": "module" }\n',
        "scripts/ci.ts": imports(["../src/links/deep/seed.ts", "./tools/deep/helper.ts"]),
        "scripts/tools/deep/helper.ts": VALUE,
        "src/links/deep/seed.ts": VALUE,
        "parts/gamma/deep/three.ts": VALUE,
        "src/reader.ts": imports(["../parts/gamma/deep/three.ts"]),
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    const violations = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(violations).toContain(
      internalDirectory("scripts/ci.ts:1", "src/links/deep/seed.ts", "src/links"),
    );
    expect(violations).toContain(
      internalDirectory("scripts/ci.ts:2", "scripts/tools/deep/helper.ts", "scripts/tools/deep"),
    );
    expect(violations).toContain(
      internalDirectory("src/reader.ts:1", "parts/gamma/deep/three.ts", "parts/gamma"),
    );
  }).pipe(Effect.scoped),
);

const privateCode = (location: string, importedPath: string, module: string) =>
  `${location}: error PrivateCodeImported: imports ${importedPath}, which is private to ${module}/: only its index and files in ${module}/internal/ may import it`;

export const internalDirectoriesArePrivateToTheirModule = Task.make(
  "a module's internal/ is importable only by that module's index.ts or index.tsx, by files in the same internal/ and by tests, so a submodule, a sibling shared/ file or a loose file in the module is PrivateCodeImported, nested modules included, whether or not a program or test reaches the importer",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "privacy", "type": "module", "main": "./src/index.ts" }\n',
        "src/index.ts": imports(["./store/index.ts", "./web/index.tsx"]),
        "src/store/index.ts": imports(["./internal/read.ts", "./reader/index.ts"]),
        "src/store/internal/read.ts": imports(["./parse.ts"]),
        "src/store/internal/parse.ts": VALUE,
        "src/store/shared/format.ts": imports(["../internal/read.ts"]),
        "src/store/loose.ts": imports(["./internal/read.ts"]),
        "src/store/reader/index.ts": imports(["./internal/own.ts", "../internal/read.ts"]),
        "src/store/reader/internal/own.ts": imports(["../../internal/read.ts"]),
        "src/web/index.tsx": imports(["./internal/view.ts"]),
        "src/web/internal/view.ts": VALUE,
        "scripts/ci.ts": imports(["../tests/store.ts"]),
        "tests/store.ts": imports(["../src/store/internal/read.ts"]),
      },
      "lintConfig({})",
      { ...PROJECT_FIELDS, include: ["**/*.ts", "**/*.tsx"] },
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        privateCode("src/store/shared/format.ts:1", "src/store/internal/read.ts", "src/store"),
        privateCode("src/store/loose.ts:1", "src/store/internal/read.ts", "src/store"),
        privateCode("src/store/reader/index.ts:2", "src/store/internal/read.ts", "src/store"),
        privateCode(
          "src/store/reader/internal/own.ts:1",
          "src/store/internal/read.ts",
          "src/store",
        ),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const hiddenImportsStateOnlyWhatHidesThem = Task.make(
  "a hidden import states only the import and the module or internal/ that hides it, never where a file belongs: a script importing an index or a file deep in a source module, and a Worker started loose in a module or a loose file importing that module's internal/",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "destinations", "type": "module", "main": "./src/index.ts" }\n',
        "src/index.ts": [
          'import { VALUE as A } from "./a/index.ts";',
          'import { VALUE as B } from "./b/index.ts";',
          'export const WORKER = new Worker(new URL("./a/work.ts", import.meta.url));',
          "export const VALUE = [A, B];",
          "",
        ].join("\n"),
        "src/a/index.ts": imports(["./x.ts", "./loose.ts", "./internal/kept.ts"]),
        "src/a/x.ts": VALUE,
        "src/a/loose.ts": importing("./internal/kept.ts"),
        "src/a/internal/kept.ts": VALUE,
        "src/a/work.ts": 'import { VALUE } from "./internal/helper.ts";\nconsole.info(VALUE);\n',
        "src/a/internal/helper.ts": VALUE,
        "src/b/index.ts": VALUE,
        "src/b/only.ts": VALUE,
        "src/b/c/index.ts": importing("./internal/step.ts"),
        "src/b/c/internal/step.ts": VALUE,
        "scripts/ci.ts": imports([
          "../src/index.ts",
          "../src/a/index.ts",
          "../src/b/c/index.ts",
          "./shared/tool.ts",
        ]),
        "scripts/shared/tool.ts": imports(["../../src/a/x.ts", "../../src/b/only.ts"]),
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        moduleInternals("scripts/ci.ts:2", "src/a/index.ts", "src"),
        moduleInternals("scripts/ci.ts:3", "src/b/c/index.ts", "src"),
        moduleInternals("scripts/shared/tool.ts:1", "src/a/x.ts", "src"),
        moduleInternals("scripts/shared/tool.ts:2", "src/b/only.ts", "src"),
        privateCode("src/a/work.ts:1", "src/a/internal/helper.ts", "src/a"),
        privateCode("src/a/loose.ts:1", "src/a/internal/kept.ts", "src/a"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const directoriesTheLayoutCheckReportsAddNoImportErrors = Task.make(
  "an import from the parent into a directory nested in an internal/ or shared/, which the layout check reports as DirectoryInInternalOrShared, and an import of a file beside an index.ts in shared/, which is no module, add no import error, while importing another module's internals still does, and the package root is no module, so a root internal/ is not PrivateCodeImported and is open to every file",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "once", "type": "module", "main": "./src/index.ts" }\n',
        "index.ts": imports(["./internal/root.ts"]),
        "internal/root.ts": VALUE,
        "src/index.ts": imports(["./a/index.ts", "./b/index.ts", "./shared/index.ts"]),
        "src/a/index.ts": imports(["./internal/sub/deep.ts", "./shared/sub/wide.ts"]),
        "src/a/internal/sub/deep.ts": VALUE,
        "src/a/shared/sub/wide.ts": VALUE,
        "src/b/index.ts": imports(["../shared/beside.ts", "../a/internal/sub/deep.ts"]),
        "src/shared/index.ts": VALUE,
        "src/shared/beside.ts": VALUE,
        "src/c.ts": imports(["../internal/root.ts"]),
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual([
      moduleInternals("src/b/index.ts:2", "src/a/internal/sub/deep.ts", "src/a"),
    ]);
  }).pipe(Effect.scoped),
);

export const anInternalOfNoModuleIsPrivateToNothing = Task.make(
  "an internal/ whose parent is no module is not PrivateCodeImported, so in a directory with no index.ts, a loose file importing the internal/ beside it is checked like an import of any other directory and passes",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "loose", "type": "module", "bin": "./src/cli.ts" }\n',
        "src/cli.ts": imports(["./internal/value.ts"]),
        "src/internal/value.ts": VALUE,
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    expect(yield* violationsOf(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped),
);

export const anIndexNestedInInternalOrSharedMakesNoModule = Task.make(
  "an index.ts in a directory nested in an internal/ or shared/ makes no module, so the files beside it are not module internals, and importing it is PrivateCodeImported or ModuleInternalsImported like importing any other file of that internal/ or shared/",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "nested", "type": "module", "main": "./src/index.ts" }\n',
        "src/index.ts": imports(["./a/index.ts", "./b/index.ts"]),
        "src/a/index.ts": imports([
          "./internal/sub/index.ts",
          "./internal/sub/beside.ts",
          "./shared/sub/index.ts",
          "./part/index.ts",
        ]),
        "src/a/part/index.ts": imports(["../internal/sub/index.ts", "../shared/sub/index.ts"]),
        "src/a/internal/sub/index.ts": importing("./beside.ts"),
        "src/a/internal/sub/beside.ts": VALUE,
        "src/a/shared/sub/index.ts": VALUE,
        "src/b/index.ts": importing("../a/shared/sub/index.ts"),
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        moduleInternals("src/b/index.ts:1", "src/a/shared/sub/index.ts", "src/a"),
        privateCode("src/a/part/index.ts:1", "src/a/internal/sub/index.ts", "src/a"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const onlyANamedPackageJsonMakesAPackage = Task.make(
  'only a package.json with a string name makes a package, so a nested package.json with no name, such as { "type": "module" } or { "sideEffects": false }, leaves its directory in the enclosing package and module: its module\'s index imports its internal/ and an outsider importing it is ModuleInternalsImported, just as when the internal/ has no package.json, while a nested package.json with a name still makes the files below it another package whose internals no outsider imports',
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "package.json": '{ "name": "unnamed", "type": "module", "main": "./src/index.ts" }\n',
        "src/index.ts": imports([
          "./n/index.ts",
          "./n/internal/x.ts",
          "./p/internal/x.ts",
          "./q/internal/x.ts",
        ]),
        "src/n/index.ts": imports(["./internal/x.ts", "./shared/y.ts"]),
        "src/n/internal/package.json": '{ "type": "module" }\n',
        "src/n/internal/x.ts": VALUE,
        "src/n/shared/package.json": '{ "sideEffects": false }\n',
        "src/n/shared/y.ts": VALUE,
        "src/p/index.ts": imports(["./internal/x.ts"]),
        "src/p/internal/package.json": '{ "name": "nested" }\n',
        "src/p/internal/x.ts": VALUE,
        "src/q/index.ts": imports(["./internal/x.ts"]),
        "src/q/internal/x.ts": VALUE,
      },
      "lintConfig({})",
      PROJECT_FIELDS,
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        moduleInternals("src/index.ts:2", "src/n/internal/x.ts", "src/n"),
        moduleInternals("src/index.ts:4", "src/q/internal/x.ts", "src/q"),
        moduleInternals("src/index.ts:3", "src/p/internal/x.ts", "src/p"),
        packageInternals("src/p/index.ts:1", "src/p/internal/x.ts", "src/p/internal"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const aMalformedPackageJsonFailsTheCheck = Task.make(
  'a nested package.json whose name is no string, such as { "name": 1 }, or that is no JSON, fails the import-boundary check with PackageManifestUnreadable at that package.json, from the listing of the package\'s files, instead of counting as unnamed',
  Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const manifest of ['{ "name": 1, "sideEffects": false }\n', "{ name: shared }\n"]) {
      const { directory, tsconfigFile } = yield* makeProject(
        {
          "package.json": '{ "name": "unnamed", "type": "module", "main": "./src/index.ts" }\n',
          "src/index.ts": imports(["./n/index.ts"]),
          "src/n/index.ts": imports(["./shared/y.ts"]),
          "src/n/shared/package.json": manifest,
          "src/n/shared/y.ts": VALUE,
        },
        "lintConfig({})",
        PROJECT_FIELDS,
      );
      const failure = yield* findImportBoundaryViolations(tsconfigFile).pipe(
        failureAsValue,
        Effect.map((error) => [error._tag, "location" in error ? error.location : "no location"]),
      );
      expect(failure).toEqual([
        "PackageManifestUnreadable",
        path.join(directory, "src/n/shared/package.json"),
      ]);
    }
  }).pipe(Effect.scoped),
);

export const modulesInLibraryDirectoriesKeepTheirBoundaries = Task.make(
  "a module in a lib/ is importable from outside only through its index, so its internal/ and its own lib/ modules are ModuleInternalsImported from outside it and its internal/ is PrivateCodeImported from its child modules, while it reaches its child modules' indexes, child modules reach their siblings' indexes and their ancestors' shared/, and lib/ itself hides nothing from its module",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "src/index.ts": imports([
          "./lib/tasks/index.ts",
          "./lib/tasks/internal/run.ts",
          "./lib/tasks/lib/layout/index.ts",
        ]),
        "src/shared/words.ts": VALUE,
        "src/internal/read.ts": imports(["../shared/words.ts", "../lib/tasks/index.ts"]),
        "src/lib/tasks/index.ts": imports(["./lib/layout/index.ts", "./internal/run.ts"]),
        "src/lib/tasks/internal/run.ts": imports(["../lib/check/index.ts"]),
        "src/lib/tasks/shared/names.ts": VALUE,
        "src/lib/tasks/lib/layout/index.ts": importing("./internal/find.ts"),
        "src/lib/tasks/lib/layout/internal/find.ts": imports([
          "../../../shared/names.ts",
          "../../../../../shared/words.ts",
          "../../check/index.ts",
          "../../../internal/run.ts",
          "../../check/internal/rules.ts",
        ]),
        "src/lib/tasks/lib/check/index.ts": importing("./internal/rules.ts"),
        "src/lib/tasks/lib/check/internal/rules.ts": VALUE,
      },
      "lintConfig({})",
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        moduleInternals("src/index.ts:2", "src/lib/tasks/internal/run.ts", "src/lib/tasks"),
        moduleInternals("src/index.ts:3", "src/lib/tasks/lib/layout/index.ts", "src/lib/tasks"),
        privateCode(
          "src/lib/tasks/lib/layout/internal/find.ts:4",
          "src/lib/tasks/internal/run.ts",
          "src/lib/tasks",
        ),
        moduleInternals(
          "src/lib/tasks/lib/layout/internal/find.ts:5",
          "src/lib/tasks/lib/check/internal/rules.ts",
          "src/lib/tasks/lib/check",
        ),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);

export const testsAreAModuleLikeSource = Task.make(
  "tests/ is a module, so scripts reach only tests/index.ts, its child modules cannot import its internal/, and a test file still imports any file outside tests/",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "src/index.ts": importing("./internal/value.ts"),
        "src/internal/value.ts": VALUE,
        "scripts/ci.ts": imports([
          "../tests/index.ts",
          "../tests/internal/passes.ts",
          "../tests/shared/helper.ts",
        ]),
        "scripts/shared/runner.ts": VALUE,
        "tests/index.ts": imports(["./internal/passes.ts", "./lib/unit/index.ts"]),
        "tests/internal/passes.ts": imports([
          "../shared/helper.ts",
          "../../src/internal/value.ts",
          "../../scripts/shared/runner.ts",
        ]),
        "tests/shared/helper.ts": VALUE,
        "tests/lib/unit/index.ts": importing("./internal/unit.ts"),
        "tests/lib/unit/internal/unit.ts": imports([
          "../../../shared/helper.ts",
          "../../../internal/passes.ts",
        ]),
      },
      "lintConfig({})",
    );
    expect((yield* violationsOf(tsconfigFile)).toSorted()).toEqual(
      [
        moduleInternals("scripts/ci.ts:2", "tests/internal/passes.ts", "tests"),
        moduleInternals("scripts/ci.ts:3", "tests/shared/helper.ts", "tests"),
        privateCode("tests/lib/unit/internal/unit.ts:2", "tests/internal/passes.ts", "tests"),
      ].toSorted(),
    );
  }).pipe(Effect.scoped),
);
