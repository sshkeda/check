import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { loadedLintConfigIn } from "../../src/lib/tasks/shared/load-the-lint-config.ts";
import {
  LintConfigRefused,
  REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
} from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { recordedGrantsOf } from "../../src/shared/record-and-grant-permissions-by-path.ts";
import {
  makeProject as makeProjectWith,
  RUNNER,
  TASKS,
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

export const generatedGrantsAreExactAndExclusive = Task.make(
  "generated grants name exact files and cannot combine with other permissions or import rules",
  Effect.sync(() => {
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
);

export const generatedGrantsRequireFiles = Task.make(
  "generated grants reject directories and missing output files",
  Effect.gen(function* () {
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
);

export const generatedSourceIsTypeCheckedAndImportChecked = Task.make(
  "Check type-checks generated source but not generated declarations, checks imports from and to generated files, and skips their lint, format and layout rules",
  Effect.gen(function* () {
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
          'import { Task } from "@sshkeda/task";\nimport { Effect } from "effect";\n\nexport const test = Task.make("example", Effect.void);\n',
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
    yield* writtenFiles(directory, {
      "run.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\nTask.main(check);\n`,
    });
    const runCheck = () => runTaskFile("bun run.ts", { cwd: directory, taskStateDirectory });
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
      `${RUNTIME_PATH}:1: error import-boundaries`,
    );
    expect(importFromGeneratedFailure.message).toContain("scripts/generated.ts");

    yield* writtenFiles(directory, {
      [RUNTIME_PATH]: RUNTIME,
      "src/internal/read.ts": `${READ}export { HIDDEN } from "../generated/internal/hidden.ts";\n`,
    });
    const importOfGeneratedFailure = yield* runCheck().pipe(failureAsValue);
    expect(importOfGeneratedFailure.message).toContain(
      "src/internal/read.ts:6: error import-boundaries",
    );
    expect(importOfGeneratedFailure.message).toContain(HIDDEN_PATH);

    yield* writtenFiles(directory, {
      ".cloudflare/types/manual.d.ts":
        "/* eslint-disable */\nexport interface Manual { VALUE: string }\n",
      "src/internal/read.ts":
        'import { Schema } from "effect";\nimport type { Manual } from "../../.cloudflare/types/manual.d.ts";\n\nexport const ENTRY = Schema.Struct({ id: Schema.String });\nexport const read = (environment: Manual, value: typeof ENTRY.Type) => environment.VALUE + value.id;\nexport const ownedAsync = async () => 1;\n',
    });
    const handwrittenFailure = yield* runCheck().pipe(failureAsValue);
    expect(handwrittenFailure.message).toContain("DisableDirective");
    expect(handwrittenFailure.message).toContain("effect(asyncFunction)");
    expect(handwrittenFailure.message).toContain("LintedDeclarationFileNotTypeChecked");
    expect(handwrittenFailure.message).toContain(".cloudflare/types/manual.d.ts");

    yield* fileSystem.remove(path.join(directory, DECLARATION_PATH));
    const missing = yield* runCheck().pipe(failureAsValue);
    expect(missing.message).toContain("grants isGeneratedByATool, but is not an existing file");
  }).pipe(Effect.scoped),
);

export const plainPermissionsDecodeToTheirNames = Task.make(
  "trustsUnverifiedTypes and isGeneratedByATool are granted by name, alone or beside other permissions",
  Effect.sync(() => {
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
);
