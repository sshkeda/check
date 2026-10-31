import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Predicate } from "effect";

import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import { packageRootViolations } from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import { isTestEntryFile } from "../../src/lib/tasks/shared/classify-files-by-role.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

export const testsUseThePackageRoot = Task.make(
  "test modules live at the package root and nested modules keep their test role",
  Effect.sync(() => {
    expect(packageRootViolations(["tests/case.ts"])).toEqual([]);
    expect(isTestEntryFile("tests/case.ts")).toBe(true);
    expect(isTestEntryFile("tests/nested/case.ts")).toBe(true);
    expect(isTestEntryFile("tests/case.d.ts")).toBe(false);
    expect(isTestEntryFile("scripts/tests/case.ts")).toBe(false);
  }),
);

export const importsTestsOnlyFromScripts = Task.make(
  "only scripts and tests can import test modules, in every supported literal form",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      ".gitignore": "node_modules\n",
      "tests/case.ts": 'import { Effect } from "effect"; export const test = Effect.void;',
      "tests/nested/deep.ts": 'import { Effect } from "effect"; export const deep = Effect.void;',
      "src/production.ts": "export const VALUE = 1;",
      "tests/reads-production.ts":
        'import { Effect } from "effect"; import { VALUE } from "../src/production.ts"; export const test = Effect.succeed(VALUE);',
      "scripts/runner.ts": 'import { test } from "../tests/case.ts"; export const run = test;',
      "scripts/shared/runner.ts": 'export { deep } from "../../tests/nested/deep.ts";',
      "scripts/nested/runner.ts": 'export const load = () => import("../../tests/case.ts");',
      "src/named.ts": 'import { test } from "../tests/case.ts"; export const run = test;',
      "src/typed.ts": 'export type Test = typeof import("../tests/case.ts").test;',
      "examples/re-exported.ts": 'export { test } from "../tests/case.ts";',
      "examples/star.ts": 'export * from "../tests/nested/deep.ts";',
      "tools/dynamic.ts": 'export const load = () => import("../tests/case.ts");',
      "scripts-other/prefix.ts": 'export { test } from "../tests/case.ts";',
      "tests/other.ts": 'import { test } from "./case.ts"; export const again = test;',
      "tests/nested/reader.ts": 'export const load = () => import("../case.ts");',
      "src/resolved.ts": 'export const test = import.meta.resolve("../tests/case.ts");',
      "src/url.ts": 'export const test = new URL("../tests/case.ts", import.meta.url);',
      "src/worker.ts":
        'export const worker = new Worker(new URL("../tests/case.ts", import.meta.url));',
      "nested/package.json": '{"name":"nested-package"}',
      "nested/tests/case.ts": 'import { Effect } from "effect"; export const test = Effect.void;',
      "nested/src/owner.ts": 'export { test } from "../tests/case.ts";',
    });
    const importedTests = yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(
          failure.violations
            .filter((violation) => Predicate.isTagged(violation, "TestImported"))
            .map(({ location, importedPath }) => `${location}: ${importedPath}`),
        ),
      ),
    );
    expect(importedTests.toSorted()).toEqual([
      "examples/re-exported.ts:1: tests/case.ts",
      "examples/star.ts:1: tests/nested/deep.ts",
      "scripts-other/prefix.ts:1: tests/case.ts",
      "src/named.ts:1: tests/case.ts",
      "src/resolved.ts:1: tests/case.ts",
      "src/typed.ts:1: tests/case.ts",
      "src/url.ts:1: tests/case.ts",
      "src/worker.ts:1: tests/case.ts",
      "tools/dynamic.ts:1: tests/case.ts",
    ]);
  }).pipe(Effect.scoped),
);
