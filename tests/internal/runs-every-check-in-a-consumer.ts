import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  FORMAT_CONFIG_TEXT,
  linkNodeModulesWithCheck,
  RUNNER,
  TASKS,
  writtenFiles,
} from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { encodeIndentedJson } from "../shared/indented-json.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const consumerCheckout = (directory: string, packageName: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const options = { cwd: directory };
    yield* linkNodeModulesWithCheck(directory);
    yield* fileSystem.writeFileString(
      path.join(directory, ".gitignore"),
      "node_modules\nrun.ts\noxlint.config.ts\noxfmt.config.ts\n",
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "oxlint.config.ts"),
      `import { lintConfig } from "@sshkeda/check";\nexport default lintConfig({});\n`,
    );
    yield* fileSystem.writeFileString(path.join(directory, "oxfmt.config.ts"), FORMAT_CONFIG_TEXT);
    yield* fileSystem.writeFileString(
      path.join(directory, "package.json"),
      `${yield* encodeIndentedJson({ name: packageName, type: "module", main: "./src/index.ts" })}\n`,
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "tsconfig.json"),
      `${yield* encodeIndentedJson({ compilerOptions: { strict: true, types: [], ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true }, files: ["src/index.ts"] })}\n`,
    );
    yield* fileSystem.makeDirectory(path.join(directory, "src"));
    yield* fileSystem.writeFileString(
      path.join(directory, "src/index.ts"),
      'export const VALUE = "valid";\n',
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "run.ts"),
      `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\nTask.main(check);\n`,
    );
    yield* Task.exec("git", ["init", "--quiet"], options);
    yield* Task.exec("bun", ["fmt", "."], options);
  });

const runCheckIn = (directory: string, taskStateDirectory: string) =>
  runTaskFile("bun run.ts", { cwd: directory, taskStateDirectory });

export const ignoredProjectConfigsAreRead = Task.make(
  "every source check can read valid gitignored root and referenced tsconfig files",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
    yield* consumerCheckout(directory, path.basename(directory));
    yield* fileSystem.writeFileString(
      path.join(directory, ".gitignore"),
      "node_modules\nrun.ts\noxlint.config.ts\noxfmt.config.ts\ntsconfig.json\n",
    );
    yield* writtenFiles(directory, {
      "tsconfig.json": yield* encodeJson({
        compilerOptions: {
          strict: true,
          types: [],
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          noEmit: true,
        },
        files: ["src/index.ts"],
        references: [{ path: "./src/internal" }],
      }),
      "src/internal/tsconfig.json": yield* encodeJson({
        extends: "../../tsconfig.json",
        compilerOptions: {
          composite: true,
          noEmit: false,
          emitDeclarationOnly: true,
          outDir: "../dist",
        },
        files: ["value.ts"],
        references: [],
      }),
      "src/internal/value.ts": "export const VALUE = 1;\n",
      "src/index.ts": 'export { VALUE } from "./internal/value.js";\n',
    });
    yield* Task.exec("bun", ["fmt", "."], { cwd: directory });
    const output = yield* runCheckIn(directory, taskStateDirectory).pipe(
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    for (const name of [
      "directives",
      "oxlint",
      "effect-tsgo",
      "checker-queries",
      "linted-files-type-checked",
    ]) {
      expect(output).toContain(`[${name}] passed`);
    }
  }).pipe(Effect.scoped),
);

export const rerunsChecksAfterSourceChanges = Task.make(
  "exported check tasks run in a consumer, and every run checks the source again",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      yield* consumerCheckout(directory, path.basename(directory));
      yield* runCheckIn(directory, taskStateDirectory);
      expect(yield* runCheckIn(directory, taskStateDirectory)).not.toContain("cached");
      yield* fileSystem.writeFileString(
        path.join(directory, "src/index.ts"),
        "export const VALUE: string = 1;\n",
      );
      const failure = yield* runCheckIn(directory, taskStateDirectory).pipe(failureAsValue);
      expect(failure.message).toContain("not assignable");
    }),
  ),
);

export const rerunsChecksWhenAnIgnoredImportGoesMissing = Task.make(
  "removing a gitignored file that source imports makes the next check report ImportOfMissingIgnoredFile",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      yield* consumerCheckout(directory, path.basename(directory));
      yield* fileSystem.writeFileString(
        path.join(directory, ".gitignore"),
        "node_modules\nrun.ts\noxlint.config.ts\noxfmt.config.ts\n.generated/\n",
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "tsconfig.json"),
        `${yield* encodeIndentedJson({ compilerOptions: { strict: true, types: ["bun"], ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true }, files: ["src/index.ts"] })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "src/index.ts"),
        'import page from "../.generated/page.txt";\n\nexport const VALUE = page.trim();\n',
      );
      yield* Task.exec("bun", ["fmt", "."], {
        cwd: directory,
      });
      yield* fileSystem.makeDirectory(path.join(directory, ".generated"));
      yield* fileSystem.writeFileString(path.join(directory, ".generated/page.txt"), "page\n");
      yield* runCheckIn(directory, taskStateDirectory);
      yield* fileSystem.remove(path.join(directory, ".generated/page.txt"));
      const failure = yield* runCheckIn(directory, taskStateDirectory).pipe(failureAsValue);
      expect(failure.message).toContain(
        "[checker-queries] src/index.ts:1: error import-boundaries ImportOfMissingIgnoredFile: imports ../.generated/page.txt, but .generated/page.txt does not exist and is gitignored",
      );
    }),
  ),
);
