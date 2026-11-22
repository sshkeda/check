import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { findDisableDirectivesInLintedFilesOf } from "../../src/lib/tasks/lib/refuse-disable-directives/internal/find-disable-directives.ts";
import { loadedLintConfigIn } from "../../src/lib/tasks/shared/load-the-lint-config.ts";
import {
  LintConfigRefused,
  REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
} from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { recordedGrantsOf } from "../../src/shared/record-and-grant-permissions-by-path.ts";
import {
  theCheckCommand,
  makeProject as makeProjectWith,
  FORMAT_CONFIG_TEXT,
  writtenFiles,
} from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const DECLARATIONS = `/* eslint-disable */
declare namespace Cloudflare { interface Env { VALUE: string } }
interface UpstreamIssue extends MissingUpstreamType {}
`;
const DECLARATION_PATH = ".cloudflare/types/index.d.ts";
const RUNTIME_PATH = "src/generated/BadName.ts";
const HIDDEN_PATH = "src/generated/internal/hidden.ts";
const RUNTIME = `/* eslint-disable */
export interface Generated { name: string }
export const VALUE={name:"value"};
export const generatedAsync = async () => 1;
`;
const READ =
  'import { Schema } from "effect";\nimport { VALUE } from "../generated/BadName.ts";\n\nexport const ENTRY = Schema.Struct({ id: Schema.String });\nexport const read = (environment: Cloudflare.Env, value: typeof ENTRY.Type) => environment.VALUE.toUpperCase() + VALUE.name + value.id;\n';

export const generatedGrantsAreExactAndExclusive = Task.make({
  name: "generated grants name exact files and cannot combine with other permissions or import rules",
  run: Effect.sync(() => {
    expect(
      recordedGrantsOf({
        "docs/output.md": { allow: ["isGeneratedByATool"] },
      }),
    ).toMatchObject({
      grants: [{ path: "docs/output.md", allow: ["isGeneratedByATool"] }],
    });
    for (const entry of [
      { allow: ["isGeneratedByATool", "writesToTheTerminal"] },
      { allow: ["isGeneratedByATool"], services: ["Store"] },
      {
        allow: ["isGeneratedByATool"],
        cannotImport: ["src/private"],
      },
    ]) {
      expect(recordedGrantsOf({ "output.ts": entry }).violations?.length).toBeGreaterThan(0);
    }
    expect(
      recordedGrantsOf({
        "outputs/*": { allow: ["isGeneratedByATool"] },
      }).violations?.length,
    ).toBeGreaterThan(0);
  }),
});

export const generatedGrantsRequireFiles = Task.make({
  name: "generated grants reject directories and missing output files",
  run: Effect.gen(function* () {
    for (const file of ["src", "missing.d.ts"]) {
      const { directory } = yield* makeProject(
        { "src/index.ts": "export const VALUE = 1;\n" },
        `lintConfig({ "${file}": { allow: ["isGeneratedByATool"] } })`,
      );
      const failure = yield* loadedLintConfigIn(directory).pipe(failureAsValue);
      expect(failure).toBeInstanceOf(LintConfigRefused);
      expect(failure.message).toContain("grants isGeneratedByATool, but is not an existing file");
    }
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const generatedSourceIsTypeCheckedAndImportChecked = Task.make({
  name: "Check type-checks generated source but not generated declarations, checks imports from and to generated files, and skips their lint, format and layout rules",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      {
        "oxfmt.config.ts": FORMAT_CONFIG_TEXT,
        ".gitignore": "node_modules\nrun.ts\noxlint.config.ts\noxfmt.config.ts\n.cloudflare/\n",
        "package.json":
          '{ "name": "generated-types", "type": "module", "main": "./src/index.ts", "module": "./src/index.ts", "exports": "./src/index.ts" }\n',
        [DECLARATION_PATH]: DECLARATIONS,
        [RUNTIME_PATH]: RUNTIME,
        [HIDDEN_PATH]: "export const HIDDEN = 1;\n",
        "vendor/output.json": '{"generated":true}\n',
        "src/index.ts": 'export { ENTRY, read } from "./internal/read.ts";\n',
        "scripts/generated.ts":
          'import { Schema } from "effect";\nimport { ENTRY } from "../src/index.ts";\nimport { test } from "../tests/index.ts";\nvoid Schema.decodeUnknownSync(ENTRY);\nvoid test;\n',
        "tests/index.ts": 'export { test } from "./internal/example.ts";\n',
        "tests/internal/example.ts":
          'import { Task } from "@sshkeda/task";\nimport { Effect } from "effect";\n\nexport const test = Task.make({ name: "example", run: Effect.void });\n',
        "src/internal/read.ts": READ,
      },
      `lintConfig({ "src/index.ts": { allow: ["isGeneratedByATool"] }, "scripts/generated.ts": { allow: ["isGeneratedByATool"] }, "${DECLARATION_PATH}": { allow: ["isGeneratedByATool"] }, "${RUNTIME_PATH}": { allow: ["isGeneratedByATool"] }, "${HIDDEN_PATH}": { allow: ["isGeneratedByATool"] }, "vendor/output.json": { allow: ["isGeneratedByATool"] } })`,
      {
        files: ["src/index.ts"],
        include: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
        compilerOptions: {
          strict: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          types: ["bun", `./${DECLARATION_PATH}`],
          skipLibCheck: true,
        },
      },
    );
    const checkCommand = yield* theCheckCommand;
    const runCheck = () => runTaskFile(checkCommand, { cwd: directory, taskStateDirectory });
    yield* runTaskFile(
      "bun fmt --config=oxfmt.config.ts --disable-nested-config oxfmt.config.ts oxlint.config.ts tsconfig.json package.json src/internal/read.ts tests/index.ts tests/internal/example.ts",
      { cwd: directory, taskStateDirectory },
    );
    yield* runCheck();

    yield* writtenFiles(directory, {
      [DECLARATION_PATH]: DECLARATIONS.replace("VALUE: string", "VALUE: number"),
    });
    const typeFailure = yield* runCheck().pipe(failureAsValue);
    expect(typeFailure.message).toContain("TS2339");
    expect(typeFailure.message).toContain("src/internal/read.ts");

    yield* writtenFiles(directory, {
      [DECLARATION_PATH]: DECLARATIONS,
      [RUNTIME_PATH]: `import "../../scripts/generated.ts";\n${RUNTIME}`,
    });
    const importFromGeneratedFailure = yield* runCheck().pipe(failureAsValue);
    expect(importFromGeneratedFailure.message).toContain(
      `error: [checker-queries] ${RUNTIME_PATH}:1: import-boundaries`,
    );
    expect(importFromGeneratedFailure.message).toContain("scripts/generated.ts");

    yield* writtenFiles(directory, {
      [RUNTIME_PATH]: RUNTIME,
      "src/internal/read.ts": `${READ}export { HIDDEN } from "../generated/internal/hidden.ts";\n`,
    });
    const importOfGeneratedFailure = yield* runCheck().pipe(failureAsValue);
    expect(importOfGeneratedFailure.message).toContain(
      "error: [checker-queries] src/internal/read.ts:6: import-boundaries",
    );
    expect(importOfGeneratedFailure.message).toContain(HIDDEN_PATH);

    yield* writtenFiles(directory, {
      ".cloudflare/types/manual.d.ts":
        "/* eslint-disable */\nexport interface Manual { VALUE: string }\n",
      "src/internal/read.ts":
        'import { Schema } from "effect";\nimport type { Manual } from "../../.cloudflare/types/manual.d.ts";\n\nexport const ENTRY = Schema.Struct({ id: Schema.String });\nexport const read = (environment: Manual, value: typeof ENTRY.Type) => environment.VALUE + value.id;\nexport const ownedAsync = async () => 1;\n',
    });
    const handwritten = yield* runCheck().pipe(
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    expect(handwritten).toContain("DisableDirective");
    expect(handwritten).toContain("effect(asyncFunction)");
    expect(handwritten).toContain("LintedDeclarationFileNotTypeChecked");
    expect(handwritten).toContain(".cloudflare/types/manual.d.ts");

    yield* fileSystem.remove(path.join(directory, DECLARATION_PATH));
    const missing = yield* runCheck().pipe(
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    expect(missing).toContain("grants isGeneratedByATool, but is not an existing file");
  }).pipe(Effect.scoped),
});

const GENERATED_WITHOUT_TYPE_CHECKING = "src/internal/generated.ts";

const GENERATED_WITH_THREE_SLASHES = "src/internal/generated-with-three-slashes.ts";

const GENERATED_WITH_A_SUPPRESSION = "src/internal/generated-with-a-suppression.ts";

const GENERATED_WITH_A_PERIOD = "src/internal/generated-with-a-period.ts";

const GENERATED_WITH_A_LONGER_WORD = "src/internal/generated-with-a-longer-word.ts";

export const generatedSourceCannotTurnOffTypeChecking = Task.make({
  name: "a generated source that turns off its own type checking with @ts-nocheck, @ts-ignore or @ts-expect-error is reported, though the grant skips its other directives",
  run: Effect.gen(function* () {
    const { directory } = yield* makeProject(
      {
        [GENERATED_WITHOUT_TYPE_CHECKING]:
          '// @ts-nocheck\n/* eslint-disable */\nexport const VALUE: number = "bad";\n',
        [GENERATED_WITH_THREE_SLASHES]: '/// @ts-nocheck\nexport const OTHER: number = "bad";\n',
        [GENERATED_WITH_A_SUPPRESSION]:
          '/* eslint-disable */\nexport const FIRST = 1;\n// @ts-expect-error\nexport const SECOND: number = "bad";\n/* @ts-ignore */\nexport const THIRD: number = "bad";\n',
        [GENERATED_WITH_A_PERIOD]:
          '// @ts-nocheck. Generated file.\nexport const FOURTH: number = "bad";\n',
        [GENERATED_WITH_A_LONGER_WORD]:
          "// @ts-nocheckers ran on this file\nexport const FIFTH = 5;\n",
      },
      `lintConfig({ "${GENERATED_WITHOUT_TYPE_CHECKING}": { allow: ["isGeneratedByATool"] }, "${GENERATED_WITH_THREE_SLASHES}": { allow: ["isGeneratedByATool"] }, "${GENERATED_WITH_A_SUPPRESSION}": { allow: ["isGeneratedByATool"] }, "${GENERATED_WITH_A_PERIOD}": { allow: ["isGeneratedByATool"] }, "${GENERATED_WITH_A_LONGER_WORD}": { allow: ["isGeneratedByATool"] } })`,
    );
    const reported = yield* findDisableDirectivesInLintedFilesOf(directory).pipe(
      Effect.as([]),
      Effect.catchTag("ReportedErrors", ({ reportedErrors }) => Effect.succeed(reportedErrors)),
    );
    expect(reported).toEqual([
      {
        tag: "DisableDirective",
        location: `${GENERATED_WITH_A_PERIOD}:1`,
        message: "has disable directive @ts-nocheck. Generated file.",
      },
      {
        tag: "DisableDirective",
        location: `${GENERATED_WITH_A_SUPPRESSION}:3`,
        message: "has disable directive @ts-expect-error",
      },
      {
        tag: "DisableDirective",
        location: `${GENERATED_WITH_A_SUPPRESSION}:5`,
        message: "has disable directive @ts-ignore",
      },
      {
        tag: "DisableDirective",
        location: `${GENERATED_WITH_THREE_SLASHES}:1`,
        message: "has disable directive @ts-nocheck",
      },
      {
        tag: "DisableDirective",
        location: `${GENERATED_WITHOUT_TYPE_CHECKING}:1`,
        message: "has disable directive @ts-nocheck",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const plainPermissionsDecodeToTheirNames = Task.make({
  name: "trustsUnverifiedTypes and isGeneratedByATool are granted by name, alone or beside other permissions",
  run: Effect.sync(() => {
    expect(
      recordedGrantsOf({
        "port.ts": {
          allow: ["usesSqlDatabases", "trustsUnverifiedTypes"],
        },
        "output.ts": { allow: ["isGeneratedByATool"] },
      }),
    ).toMatchObject({
      grants: [
        { path: "port.ts", allow: ["usesSqlDatabases", "trustsUnverifiedTypes"] },
        { path: "output.ts", allow: ["isGeneratedByATool"] },
      ],
    });
  }),
});
