import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Array as Arrays, Effect, FileSystem, flow, Path } from "effect";

import { findFileLayoutViolations } from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import { findShebangsOutsideBin } from "../../src/lib/tasks/lib/lint-with-oxlint/internal/find-shebangs-outside-bin.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { theCheckCommand, makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const SHEBANG = "#!/usr/bin/env bun\n";

const LAUNCHER = `${SHEBANG}import { Effect } from "effect";\n\nif (import.meta.main) {\n  Effect.runFork(Effect.void);\n}\n`;

const shebangOutsideBin = (path: string) =>
  `${path}:1: error ShebangOutsideBin: starts with a shebang line, but package.json does not list it under bin`;

const WITHOUT_DEFAULT_EXPORT =
  "error TopLevelScriptWithoutDefaultExport: sits directly in scripts/ and has no default export";

const writtenRepository = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    for (const [file, text] of Object.entries(files)) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(directory, file), text);
    }
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    return directory;
  });

const NOT_SHEBANGS = {
  "src/internal/answer.ts": "export const ANSWER = 42;\n",
  "src/internal/quoted.ts": "export const PATH = '#!/usr/bin/env bun';\n",
  "src/internal/template.ts": "export const SOURCE = `\n#!/usr/bin/env bun\n`;\n",
  "src/internal/private-field.ts": "export const PRIVATE_FIELD = class { #value = 1; };\n",
} as const;

export const onlyTheFilesPackageJsonListsUnderBinMayStartWithAShebang = Task.make({
  name: "a shebang line is reported in each given file except those package.json lists under bin, wherever they live, and not in a file merely named like one, while hash text that is not a shebang is left alone",
  run: Effect.gen(function* () {
    const files = {
      ".gitignore": "node_modules\n",
      "package.json": yield* encodeJson({
        name: "tool",
        bin: { tool: "./scripts/tool.ts", cli: "src/internal/cli.ts" },
      }),
      "scripts/tool.ts": LAUNCHER,
      "scripts/check.ts": LAUNCHER,
      "src/internal/cli.ts": `${SHEBANG}export const CLI = 1;\n`,
      "src/internal/value.ts": `${SHEBANG}export const VALUE = 1;\n`,
      "src/internal/marked.ts": `\uFEFF${SHEBANG}export const MARKED = 1;\n`,
      ...NOT_SHEBANGS,
    };
    const directory = yield* writtenRepository(files);
    const found = yield* findShebangsOutsideBin(
      directory,
      Object.keys(files).filter((file) => file.endsWith(".ts")),
    ).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ShebangsOutsideBin", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(found.toSorted()).toEqual(
      ["scripts/check.ts", "src/internal/marked.ts", "src/internal/value.ts"].map((file) =>
        shebangOutsideBin(file),
      ),
    );
  }).pipe(Effect.scoped),
});

export const aBinTargetInScriptsNeedNotBeATaskScript = Task.make({
  name: "the layout check holds a file directly in scripts/ to the Task script shape unless package.json lists it under bin",
  run: Effect.gen(function* () {
    const directory = yield* writtenRepository({
      ".gitignore": "node_modules\n",
      "package.json": yield* encodeJson({ name: "tool", bin: { tool: "./scripts/tool.ts" } }),
      "scripts/tool.ts": LAUNCHER,
      "scripts/check.ts": LAUNCHER,
    });
    const found = yield* findFileLayoutViolations(directory).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("FileLayoutViolations", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(found).toEqual([`scripts/check.ts: ${WITHOUT_DEFAULT_EXPORT}`]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const aShebangInAnIgnoredImportedFileIsReported = Task.make({
  name: "a shebang in a gitignored source file that compiled code imports is reported, as in every file the lint sees",
  run: Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* makeProject({
      ".gitignore": "node_modules\nsrc/internal/value.ts\n",
      "src/index.ts":
        'import { VALUE } from "./internal/value.ts";\n\nexport const COUNT = VALUE;\n',
      "src/internal/value.ts": `${SHEBANG}export const VALUE = 1;\n`,
    });
    const printed = yield* theCheckCommand.pipe(
      Effect.flatMap((command) => runTaskFile(command, { cwd: directory, taskStateDirectory })),
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    expect(
      printed
        .split("\n")
        .filter((line) => line.includes("src/internal/value.ts") && line.includes("shebang")),
    ).toEqual([`[oxlint] ${shebangOutsideBin("src/internal/value.ts")}`]);
  }).pipe(Effect.scoped),
});
