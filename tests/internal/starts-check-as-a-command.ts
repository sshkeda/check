import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { PROJECT_DIRECTORY_VARIABLE } from "../../src/lib/project-directory/index.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { theCheckCommand, makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const MISNAMED_FILE = "[layout] Bad_Name.ts: error NotKebabCase: Bad_Name.ts is not kebab-case";

const commandOutcome = (
  directory: string,
  taskStateDirectory: string,
  environment: Readonly<Record<string, string>> = {},
  givenArguments = "",
) =>
  theCheckCommand.pipe(
    Effect.flatMap((command) =>
      runTaskFile(`${command}${givenArguments}`, {
        cwd: directory,
        taskStateDirectory,
        env: environment,
      }),
    ),
    Effect.map((printed) => ({ code: 0, printed })),
    Effect.catchTag("CommandFailed", (failure) =>
      Effect.succeed({ code: failure.code, printed: failure.standardOutput }),
    ),
  );

const reportedLines = (printed: string) =>
  printed
    .split("\n")
    .filter((line) => / error /u.test(line) && line.startsWith("["))
    .map((line) => line.replace(/\[[\d.]+ms\]$/u, ""))
    .toSorted();

export const checksTheDirectoryItIsStartedIn = Task.make(
  "the check command checks the directory it is started in and locates each report from it, even when the variable that carries the project directory to its tasks already names another directory",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { directory, taskStateDirectory } = yield* makeProject({
      ".gitignore": "node_modules\n",
      "index.ts": "export const COUNT = 1;\n",
      "Bad_Name.ts": "export const BAD = 1;\n",
    });
    const elsewhere = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const started = yield* commandOutcome(directory, taskStateDirectory);
    const startedWithTheVariableSet = yield* commandOutcome(directory, taskStateDirectory, {
      [PROJECT_DIRECTORY_VARIABLE]: elsewhere,
    });
    expect(started.code).toBe(1);
    expect(startedWithTheVariableSet.code).toBe(1);
    expect(started.printed).toContain(MISNAMED_FILE);
    expect(reportedLines(startedWithTheVariableSet.printed)).toEqual(
      reportedLines(started.printed),
    );
    expect(started.printed.split("\n").filter((line) => /^\[[\w-]+\] \//u.test(line))).toEqual([]);
  }).pipe(Effect.scoped),
);

export const keepsPathsThatOnlyContainTheProjectPath = Task.make(
  "the check command leaves alone a path outside the project that merely contains the project's path, so two imports of different outside files stay two findings that name each file",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const { directory, taskStateDirectory } = yield* makeProject(
      { ".gitignore": "node_modules\n" },
      "lintConfig({})",
      {},
      parent,
    );
    const containingTheProjectPath = `${parent}/backup${directory}/dep.ts`;
    const besideIt = `${parent}/backupdep.ts`;
    for (const outside of [containingTheProjectPath, besideIt]) {
      yield* fileSystem.makeDirectory(path.dirname(outside), { recursive: true });
      yield* fileSystem.writeFileString(outside, "export const DEPENDENCY = 1;\n");
    }
    yield* fileSystem.writeFileString(
      path.join(directory, "index.ts"),
      `import { DEPENDENCY as FIRST } from "${containingTheProjectPath}";\nimport { DEPENDENCY as SECOND } from "${besideIt}";\n\nexport const COUNT = [FIRST, SECOND];\n`,
    );
    const { printed } = yield* commandOutcome(directory, taskStateDirectory);
    const namingEach = (outside: string) =>
      printed.split("\n").filter((line) => line.startsWith("[") && line.includes(outside));
    expect(namingEach(containingTheProjectPath)).not.toEqual([]);
    expect(
      namingEach(besideIt).filter((line) => !line.includes(containingTheProjectPath)),
    ).not.toEqual([]);
  }).pipe(Effect.scoped),
);

export const refusesToRunWithoutAProjectToCheck = Task.make(
  "the check command fails with one line naming why, and runs no other check, when it is given an argument, when its directory has no package.json and when its directory is outside a git repository",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject({
      ".gitignore": "node_modules\n",
      "index.ts": "export const COUNT = 1;\n",
    });
    const bare = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const unversioned = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* fileSystem.writeFileString(path.join(unversioned, "package.json"), "{}\n");
    for (const [startedIn, givenArguments, refusal] of [
      [
        directory,
        " --help",
        "ArgumentsNotAccepted: check takes no arguments, and was given --help",
      ],
      [bare, "", `PackageManifestMissing: ${bare} has no package.json`],
      [unversioned, "", `RepositoryNotFound: ${unversioned} is not inside a git repository`],
    ] as const) {
      const { code, printed } = yield* commandOutcome(
        startedIn,
        taskStateDirectory,
        {},
        givenArguments,
      );
      expect(code).toBe(1);
      expect(printed.split("\n").filter((line) => line.includes(" error "))).toEqual([
        `[check] error ${refusal}`,
      ]);
      expect(printed).toContain("failed: check (1 of 1 task)");
    }
  }).pipe(Effect.scoped),
);
