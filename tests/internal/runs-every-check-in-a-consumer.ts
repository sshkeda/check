import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  theCheckCommand,
  FORMAT_CONFIG_TEXT,
  linkNodeModulesWithCheck,
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
      "node_modules\noxlint.config.ts\noxfmt.config.ts\n",
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
    yield* Task.exec("git", ["init", "--quiet"], options);
    yield* Task.exec("bun", ["fmt", "."], options);
  });

const runCheckIn = (directory: string, taskStateDirectory: string) =>
  Effect.flatMap(theCheckCommand, (command) =>
    runTaskFile(command, { cwd: directory, taskStateDirectory }),
  );

const IMPORTS_OF_ONE_MODULE = 1000;

const MOST_SPANS_THE_IMPORTS_ADD = 100;

const spansInTheTraceOfACheckWith = (imports: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
    yield* consumerCheckout(directory, path.basename(directory));
    const names = Array.from({ length: imports }, (_name, index) => `VALUE_${index}`);
    yield* writtenFiles(directory, {
      "src/internal/value.ts": 'export const VALUE = "valid";\n',
      "src/index.ts": [
        ...names.map((name) => `import { VALUE as ${name} } from "./internal/value.ts";`),
        `export const VALUES = [${names.join(", ")}];`,
        "",
      ].join("\n"),
    });
    const output = yield* runCheckIn(directory, taskStateDirectory).pipe(
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    const trace = yield* fileSystem.readFileString(
      /wrote the trace to (?<file>\S+)/u.exec(output)?.groups?.["file"] ?? "",
    );
    return trace.split('"spanId":').length;
  });

export const tracesNoSpanPerImport = Task.make(
  "a check run's trace holds about as many spans when a file imports a module 1,000 times as when it imports it once",
  Effect.scoped(
    Effect.gen(function* () {
      const spansWithOneImport = yield* spansInTheTraceOfACheckWith(1);
      const spansWithManyImports = yield* spansInTheTraceOfACheckWith(IMPORTS_OF_ONE_MODULE);
      expect(spansWithManyImports - spansWithOneImport).toBeLessThan(MOST_SPANS_THE_IMPORTS_ADD);
    }),
  ),
);

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
      "node_modules\noxlint.config.ts\noxfmt.config.ts\ntsconfig.json\n",
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
        "node_modules\noxlint.config.ts\noxfmt.config.ts\n.generated/\n",
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

const checkWithAConditionedFactory = (factory: {
  readonly inactiveTarget: string;
  readonly name: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
    yield* consumerCheckout(directory, path.basename(directory));
    yield* writtenFiles(directory, {
      "package.json": `${yield* encodeIndentedJson({
        name: path.basename(directory),
        type: "module",
        main: "./src/index.ts",
        imports: {
          "#factory": {
            development: "./src/internal/factory.ts",
            default: factory.inactiveTarget,
          },
        },
      })}\n`,
      "tsconfig.json": `${yield* encodeIndentedJson({
        compilerOptions: {
          strict: true,
          types: [],
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          noEmit: true,
          module: "Preserve",
          customConditions: ["development"],
        },
        include: ["src", "tests"],
      })}\n`,
      "node_modules/bad/package.json": '{ "name": 5, "main": "index.js" }\n',
      "node_modules/bad/index.js": "export const Factory = {};\n",
      "src/internal/factory.ts": `export const ${factory.name} = { make: () => 1 };\n`,
      "src/internal/entry.ts": `import { ${factory.name} } from "#factory";\n\nexport default ${factory.name}.make();\n`,
      "tests/orphan.ts": "export const ORPHAN = 1;\n",
    });
    yield* Task.exec("bun", ["fmt", "."], { cwd: directory });
    const failure = yield* runCheckIn(directory, taskStateDirectory).pipe(failureAsValue);
    return failure.message;
  }).pipe(Effect.scoped);

const UNUSED_ENTRY =
  "[checker-queries] src/internal/entry.ts:3: error export-placement UnusedExport: export default is used by nothing";

const ORPHAN_TEST =
  "[checker-queries] tests/orphan.ts: error export-placement TestNotRun: is a test that no file directly in scripts/ reaches through its imports";

const factoryUsedOnlyByTheEntry = (name: string) =>
  `[checker-queries] src/internal/factory.ts:1: error export-placement UnusedExport: export ${name} is used only by unreached code, such as src/internal/entry.ts`;

export const aConditionalImportIsNeverATaskImport = Task.make(
  "a default export that calls make on a binding from a conditional #import is not a task default export, so export placement still reports an orphan test and the unused default export when the inactive condition points at a package whose manifest does not decode, and when it points at @sshkeda/task",
  Effect.gen(function* () {
    const unresolvableWhenInactive = yield* checkWithAConditionedFactory({
      inactiveTarget: "bad",
      name: "Factory",
    });
    expect(unresolvableWhenInactive).toContain(ORPHAN_TEST);
    expect(unresolvableWhenInactive).toContain(UNUSED_ENTRY);
    expect(unresolvableWhenInactive).toContain(factoryUsedOnlyByTheEntry("Factory"));
    const taskWhenInactive = yield* checkWithAConditionedFactory({
      inactiveTarget: "@sshkeda/task",
      name: "Task",
    });
    expect(taskWhenInactive).toContain(ORPHAN_TEST);
    expect(taskWhenInactive).toContain(UNUSED_ENTRY);
    expect(taskWhenInactive).toContain(factoryUsedOnlyByTheEntry("Task"));
  }),
);

export const theLayoutCheckFollowsOnlyMakeAndMainCalls = Task.make(
  "a script directly in scripts/ whose default export calls Task.make with Factory.all() from a conditional #import passes the layout check, which does not follow Factory into the package its inactive condition names, whose package.json does not decode",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
    yield* consumerCheckout(directory, path.basename(directory));
    yield* writtenFiles(directory, {
      "package.json": `${yield* encodeIndentedJson({
        name: path.basename(directory),
        type: "module",
        main: "./src/index.ts",
        imports: {
          "#factory": { development: "./scripts/internal/factory.ts", default: "bad" },
        },
      })}\n`,
      "tsconfig.json": `${yield* encodeIndentedJson({
        compilerOptions: {
          strict: true,
          types: [],
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          noEmit: true,
          module: "Preserve",
          customConditions: ["development"],
        },
        include: ["src", "scripts"],
      })}\n`,
      "node_modules/bad/package.json": '{ "name": 5, "main": "index.js" }\n',
      "node_modules/bad/index.js": "export const Factory = {};\n",
      "scripts/internal/factory.ts":
        'import { Effect } from "effect";\n\nexport const Factory = { all: () => Effect.void };\n',
      "scripts/ci.ts":
        'import { Task } from "@sshkeda/task";\nimport { Factory } from "#factory";\n\nexport default Task.make("ci", Factory.all());\n',
    });
    yield* Task.exec("bun", ["fmt", "."], { cwd: directory });
    const output = yield* runCheckIn(directory, taskStateDirectory).pipe(
      Effect.catchTag("CommandFailed", (failure) => Effect.succeed(failure.standardOutput)),
    );
    expect(output).not.toContain("ModuleRequestUnresolvable");
    expect(output).toContain("[layout] passed");
  }).pipe(Effect.scoped),
);
