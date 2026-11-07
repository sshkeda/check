import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { findFileLayoutViolations } from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import { findExportPlacementViolations } from "../../src/lib/tasks/lib/place-exports-in-the-narrowest-directory/internal/find-export-placement-violations.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { listedViolations } from "../../src/shared/format-reported-failures.ts";
import { makeProject } from "../shared/checked-project.ts";

const SHARED_WITH_TESTS = {
  ".gitignore": "node_modules\n",
  "scripts/shared/value.ts": "export const VALUE = 1;\n",
  "tests/index.ts": 'export { test } from "./internal/test.ts";\n',
  "tests/internal/test.ts": [
    'import { Task } from "@sshkeda/task";',
    'import { Effect } from "effect";',
    'import { VALUE } from "../../scripts/shared/value.ts";',
    'export const test = Task.make("test", Effect.succeed(VALUE));',
    "",
  ].join("\n"),
};

export const refusesScriptHelpersOutsideTheModuleLayout = Task.make(
  "a scripts helper module outside lib/ is reported with its destination, and shared helpers used by only the scripts root or one child module are reported",
  Effect.gen(function* () {
    const { directory, tsconfigFile } = yield* makeProject(
      REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      {
        ...SHARED_WITH_TESTS,
        "scripts/build.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { build } from "./platform/index.ts";',
          "if (import.meta.main) { Task.main(build); }",
          "",
        ].join("\n"),
        "scripts/ci.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { ci } from "./shared/run-tests.ts";',
          "if (import.meta.main) { Task.main(ci); }",
          "",
        ].join("\n"),
        "scripts/shared/run-tests.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { test } from "../../tests/index.ts";',
          'export const ci = Task.make("ci", test);',
          "",
        ].join("\n"),
        "scripts/platform/index.ts": 'export { build } from "./internal/build.ts";\n',
        "scripts/platform/internal/build.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { Effect } from "effect";',
          'import { VALUE } from "../../shared/value.ts";',
          'import { ONLY } from "../../shared/only.ts";',
          'export const build = Task.make("build", Effect.succeed([VALUE, ONLY]));',
          "",
        ].join("\n"),
        "scripts/shared/only.ts": "export const ONLY = 2;\n",
      },
    );
    const layout = yield* findFileLayoutViolations(directory).pipe(
      Effect.as(""),
      Effect.catchTag("FileLayoutViolations", (failure) =>
        Effect.succeed(listedViolations(failure.violations)),
      ),
    );
    expect(layout).toBe(
      "scripts/platform: error DirectoryOutsideModuleLayout: is a directory in the module scripts/ other than internal/, shared/ or lib/. Move it to scripts/lib/platform/",
    );
    const placement = yield* findExportPlacementViolations(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as(""),
      Effect.catchTag("ExportPlacementViolations", (failure) =>
        Effect.succeed(listedViolations(failure.violations)),
      ),
    );
    expect(placement.split("\n").toSorted()).toEqual([
      "scripts/shared/only.ts: error SharedFileWithOneUser: is in scripts/shared/, but only scripts/platform/ uses it outside tests and unreached code",
      "scripts/shared/run-tests.ts: error SharedFileWithOneUser: is in scripts/shared/, but no submodule of scripts/ uses it outside tests and unreached code",
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const acceptsScriptHelpersInTheModuleLayout = Task.make(
  "runnable scripts, internal helpers, child modules in lib/ and helpers shared with tests pass without a scripts/index.ts",
  Effect.gen(function* () {
    const { directory, tsconfigFile } = yield* makeProject(
      REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      {
        ...SHARED_WITH_TESTS,
        "scripts/build.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { build } from "./lib/platform/index.ts";',
          "if (import.meta.main) { Task.main(build); }",
          "",
        ].join("\n"),
        "scripts/ci.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { ci } from "./internal/run-tests.ts";',
          "if (import.meta.main) { Task.main(ci); }",
          "",
        ].join("\n"),
        "scripts/internal/run-tests.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { test } from "../../tests/index.ts";',
          'export const ci = Task.make("ci", test);',
          "",
        ].join("\n"),
        "scripts/lib/platform/index.ts": 'export { build } from "./internal/build.ts";\n',
        "scripts/lib/platform/internal/build.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { Effect } from "effect";',
          'import { VALUE } from "../../../shared/value.ts";',
          'import { ONLY } from "./only.ts";',
          'export const build = Task.make("build", Effect.succeed([VALUE, ONLY]));',
          "",
        ].join("\n"),
        "scripts/lib/platform/internal/only.ts": "export const ONLY = 2;\n",
      },
    );
    yield* findFileLayoutViolations(directory);
    yield* findExportPlacementViolations(tsconfigFile, openTypeScriptProjects(tsconfigFile));
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);
