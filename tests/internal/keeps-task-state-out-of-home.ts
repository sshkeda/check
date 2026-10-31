import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { makeProject as makeProjectWith, RUNNER, TASKS } from "../shared/checked-project.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

export const keepsTaskStateOutOfHome = Task.make(
  "a check run by a test writes its trace to the test's own task state directory and creates no .sshkeda-task in HOME",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    const { directory, taskStateDirectory } = yield* makeProject({
      ".gitignore": "node_modules\nrun.ts\n",
      "index.ts": "export const COUNT = 1;\n",
      "run.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\nTask.main(check);\n`,
    });
    const printed = yield* runTaskFile("bun run.ts", {
      cwd: directory,
      taskStateDirectory,
      env: { HOME: home },
    }).pipe(
      Effect.catchTag("CommandFailed", (failure) =>
        Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
      ),
    );
    expect(printed).toContain(`wrote the trace to ${path.join(taskStateDirectory, "traces")}`);
    expect(yield* fileSystem.exists(path.join(home, ".sshkeda-task"))).toBe(false);
  }).pipe(Effect.scoped),
);
