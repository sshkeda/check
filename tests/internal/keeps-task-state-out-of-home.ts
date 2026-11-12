import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { theCheckCommand, makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

export const keepsTaskStateOutOfHome = Task.make({
  name: "a check run by a test writes its trace to the test's own task state directory and creates no .sshkeda-task in HOME",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    const { directory, taskStateDirectory } = yield* makeProject({
      ".gitignore": "node_modules\n",
      "index.ts": "export const COUNT = 1;\n",
    });
    const printed = yield* runTaskFile(yield* theCheckCommand, {
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
});
