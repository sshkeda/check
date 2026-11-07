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
  stagedCheckModule,
} from "../shared/checked-project.ts";
import { encodeIndentedJson } from "../shared/indented-json.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const TYPE_CHECK_TASK = stagedCheckModule("src/lib/tasks/lib/type-check-with-bun-check/index.ts");

const SERVICE_YIELDS_CHECK = new URL(
  "../../src/lib/tasks/lib/detect-repeated-service-yields/index.ts",
  import.meta.url,
).href;
const CHECKS_OVER_ONE_PROJECT = new URL(
  "../../src/lib/tasks/internal/run-checks-over-one-typescript-project.ts",
  import.meta.url,
).href;
const PROJECT_QUERY_CACHES = new URL(
  "../../src/lib/tasks/shared/provide-project-query-caches.ts",
  import.meta.url,
).href;
const TWICE = 2;

const STRICT_INDEX_TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    types: [],
    ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
  },
  files: ["index.ts"],
} as const;

const SERVICE_YIELDS_TSCONFIG = {
  compilerOptions: {
    strict: true,
    module: "Preserve",
    moduleResolution: "Bundler",
    skipLibCheck: true,
    noEmit: true,
    types: [],
    ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
  },
  files: ["index.ts"],
} as const;

export const printsToolOutputWithDetailInTrace = Task.make(
  "every failed check prints its exit line naming the program, oxlint violations from its JSON report once each without its help, and messages that contain hint: stay whole, while the trace keeps the command and cause, and a package.json check script never runs in place of the type checker",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
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
      yield* fileSystem.writeFileString(
        path.join(directory, "oxfmt.config.ts"),
        FORMAT_CONFIG_TEXT,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "package.json"),
        `${yield* encodeIndentedJson({ name: path.basename(directory), type: "module", main: "./index.ts", scripts: { check: "bun run.ts" } })}
`,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "tsconfig.json"),
        `${yield* encodeIndentedJson(STRICT_INDEX_TSCONFIG)}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "index.ts"),
        'export const double = (input: number): string => input * 2;\nexport const identifier = crypto.randomUUID();\nexport const greeting = "hello";\nexport const PARSED: number = JSON.parse("1");\nexport type Choice = "a hint: b" | string;\nexport const SCHEDULED = setTimeout(() => 1, 1);\n',
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "run.ts"),
        `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\nTask.main(check);\n`,
      );
      yield* Task.exec("git", ["init", "--quiet"], options);
      yield* Task.exec("bun", ["fmt", "."], options);
      const failures = yield* runTaskFile("bun run.ts", { ...options, taskStateDirectory }).pipe(
        Effect.as(""),
        Effect.catchTag("CommandFailed", (failure) =>
          Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
        ),
      );
      expect(failures).toMatch(
        /^\[type-check\] error ToolExited: bun exited with code [1-9]\d*$/mu,
      );
      expect(failures).not.toMatch(/^\[type-check\]\s+\[/mu);
      expect(failures).toMatch(
        /^\[type-check\] index\.ts:1:50: error TS2322: Type 'number' is not assignable to type 'string'\.$/mu,
      );
      expect(failures).toMatch(
        /^\[effect-tsgo\] (?:\S*\/)?index\.ts:2:27: error effect\(cryptoRandomUUID\): /mu,
      );
      expect(failures).toMatch(
        /^\[effect-tsgo\] error ToolExited: effect-tsgo exited with code [1-9]\d*$/mu,
      );
      expect(failures).toContain("cryptoRandomUUID");
      expect(failures).toMatch(
        /^\[oxlint\] index\.ts:3:14: error sshkeda\(no-loose-literal-constants\): const greeting is not in CAPITAL_SNAKE_CASE$/mu,
      );
      expect(failures).toMatch(/^\[oxlint\] error ToolExited: oxlint exited with code 1$/mu);
      expect(failures).toMatch(
        /^\[oxlint\] index\.ts:5:\d+: error typescript\(no-redundant-type-constituents\): a hint: b is overridden by string in this union type\.$/mu,
      );
      expect(failures).toMatch(
        /^\[oxlint\] index\.ts:6:\d+: error sshkeda\(no-timer-globals\): global setTimeout is used$/mu,
      );
      expect(failures).toMatch(
        /^\[oxlint\] index\.ts:4:\d+: error eslint\(no-restricted-properties\): 'JSON\.parse' is restricted from being used\.$/mu,
      );
      expect(failures).not.toMatch(/^\[(?:type-check|effect-tsgo|oxlint)\]\s+detected at /mu);
      expect(failures).not.toMatch(/^\[[^\]]+\]\s+hint: /mu);
      expect(failures.match(/error sshkeda\(no-loose-literal-constants\)/gu)?.length).toBe(1);
      expect(failures).not.toContain("--lspconfig");
      expect(failures).not.toContain("node_modules/.bin/");
      expect(failures).not.toMatch(/^\[[^\]]+\]\s+at /mu);
      const trace = yield* fileSystem.readFileString(
        /wrote the trace to (?<file>\S+)/u.exec(failures)?.[1] ?? "",
      );
      expect(trace).toContain("check.failure");
      expect(trace).toContain("bun check --project tsconfig.json --no-pretty --all --build");
      expect(trace).toContain("--lspconfig");
    }),
  ),
);

export const printsEachViolationWithItsTag = Task.make(
  "a checker query prints each violation as location: error <check> <Tag>: message",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
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
      yield* fileSystem.writeFileString(
        path.join(directory, "oxfmt.config.ts"),
        FORMAT_CONFIG_TEXT,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "package.json"),
        `${yield* encodeIndentedJson({ name: path.basename(directory), type: "module", main: "./index.ts" })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "tsconfig.json"),
        `${yield* encodeIndentedJson(SERVICE_YIELDS_TSCONFIG)}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "index.ts"),
        `import { Context, Effect } from "effect";
export class WorkerPool extends Context.Service<WorkerPool, { readonly run: Effect.Effect<void> }>()("WorkerPool") {}
export const program = Effect.gen(function* () {
  const first = yield* WorkerPool;
  const second = yield* WorkerPool;
  return [first, second];
});
`,
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "run.ts"),
        `import { Task } from "@sshkeda/task";\nimport { Effect } from "effect";\nimport { runChecksOverOneTypeScriptProject } from ${yield* encodeJson(CHECKS_OVER_ONE_PROJECT)};\nimport { ProjectQueryCachesLive } from ${yield* encodeJson(PROJECT_QUERY_CACHES)};\nimport { findRepeatedServiceYields } from ${yield* encodeJson(SERVICE_YIELDS_CHECK)};\nconst checkerQueries = Task.make("checker-queries", runChecksOverOneTypeScriptProject("tsconfig.json", { "service-yields": findRepeatedServiceYields }).pipe(Effect.provide(ProjectQueryCachesLive)));\nif (import.meta.main) {\n  Task.main(checkerQueries);\n}\n`,
      );
      yield* Task.exec("git", ["init", "--quiet"], options);
      const printed = yield* runTaskFile("bun run.ts", { ...options, taskStateDirectory }).pipe(
        Effect.as(""),
        Effect.catchTag("CommandFailed", (failure) =>
          Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
        ),
      );
      const lines = printed.split("\n");
      const violationLine = lines.indexOf(
        "[checker-queries] index.ts:5:18: error service-yields RepeatedServiceYield: service WorkerPool was already yielded at 4:17",
      );
      expect(violationLine).toBeGreaterThan(-1);
      expect(printed).not.toContain("detected at");
    }),
  ),
);

export const reportsEachCauseOnce = Task.make(
  "each cause is reported once by one owner: console by no-console, Date.now and JSON by no-restricted-properties, new Date() by no-clock-reads-and-sleeps, disable directives by the directives task, x! by no-non-null-assertion, async functions by effect(asyncFunction) and awaits in loops, top-level ones included, by no-await-in-loop, Effect.runSync is no Node sync method, Schema.Number gets check's message, Effect.catch is reported by no-unnamed-recovery alone, and no violation prints a hint or the help of oxlint",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const options = { cwd: directory };
      yield* linkNodeModulesWithCheck(directory);
      const files = {
        ".gitignore": "node_modules\nrun.ts\noxlint.config.ts\noxfmt.config.ts\n",
        "oxlint.config.ts": `import { lintConfig } from "@sshkeda/check";\nexport default lintConfig({});\n`,
        "oxfmt.config.ts": FORMAT_CONFIG_TEXT,
        "package.json": `${yield* encodeIndentedJson({ name: path.basename(directory), type: "module", main: "./index.ts" })}\n`,
        "tsconfig.json": `${yield* encodeIndentedJson(SERVICE_YIELDS_TSCONFIG)}\n`,
        "index.ts": [
          'import { Effect, Schema } from "effect";',
          'export const greet = (): void => console.log("hi");',
          "export const STARTED = Date.now();",
          'export const PARSED: unknown = JSON.parse("1");',
          "export const NOW = new Date();",
          "// oxlint-disable-next-line eslint/no-console",
          "export const size = (text: string): number => text!.length;",
          "export const visit = async (items: ReadonlyArray<string>) => {",
          "  for (const item of items) {",
          "    await Promise.resolve(item);",
          "  }",
          "};",
          "export const AMOUNT = Schema.Number;",
          `export const loose = (value: any): string => \`\${value}\`;`,
          "export const ANSWER = Effect.runSync(Effect.succeed(1));",
          'export const refail = (work: Effect.Effect<number, string>) => work.pipe(Effect.catch((error) => (error === "a" ? Effect.fail(error) : Effect.void)));',
          'export const logged = (work: Effect.Effect<number, string>) => work.pipe(Effect.catch((error) => (error === "a" ? Effect.fail(error) : Effect.log(error).pipe(Effect.as(1)))));',
          "export const shape = (value: Record<string, unknown>) => value;",
          'for (const step of ["a", "b"]) {',
          "  await Promise.resolve(step);",
          "}",
          "",
        ].join("\n"),
        "run.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\nTask.main(check);\n`,
      };
      for (const [file, text] of Object.entries(files)) {
        yield* fileSystem.writeFileString(path.join(directory, file), text);
      }
      yield* Task.exec("git", ["init", "--quiet"], options);
      yield* Task.exec("bun", ["fmt", "."], options);
      const printed = yield* runTaskFile("bun run.ts", { ...options, taskStateDirectory }).pipe(
        Effect.as(""),
        Effect.catchTag("CommandFailed", (failure) =>
          Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
        ),
      );
      expect(printed).toMatch(/^\[oxlint\] index\.ts:2:\d+: error eslint\(no-console\): .*$/mu);
      expect(printed).toMatch(
        /^\[oxlint\] index\.ts:3:\d+: error eslint\(no-restricted-properties\): 'Date\.now' is restricted from being used\.$/mu,
      );
      expect(printed).toMatch(
        /^\[oxlint\] index\.ts:4:\d+: error eslint\(no-restricted-properties\): 'JSON\.parse' is restricted from being used\.$/mu,
      );
      expect(printed).toMatch(
        /^\[oxlint\] index\.ts:\d+:\d+: error typescript\(no-restricted-types\): Do not use `Record<string, unknown>` as a type$/mu,
      );
      expect(printed).toMatch(
        /^\[oxlint\] index\.ts:5:\d+: error sshkeda\(no-clock-reads-and-sleeps\)/mu,
      );
      expect(printed).toMatch(/^\[directives\] index\.ts:6: error DisableDirective: /mu);
      expect(printed).toMatch(
        /^\[oxlint\] index\.ts:7:\d+: error typescript\(no-non-null-assertion\)/mu,
      );
      expect(printed).toMatch(/^\[effect-tsgo\] index\.ts:8:\d+: error effect\(asyncFunction\)/mu);
      expect(printed).toMatch(
        /^\[effect-tsgo\] index\.ts:13:\d+: error effect\(schemaNumber\): Schema\.Number accepts NaN, Infinity and -Infinity$/mu,
      );
      expect(printed).toMatch(
        /^\[oxlint\] index\.ts:14:\d+: error typescript\(no-explicit-any\): /mu,
      );
      expect(printed).not.toMatch(/^\[[^\]]+\]\s+hint: /mu);
      expect(printed).toMatch(
        /^\[oxlint\] index\.ts:\d+:\d+: error eslint\(no-await-in-loop\): .*$/mu,
      );
      expect(printed).not.toContain("Promise.all");
      expect(
        printed.match(
          /^\[oxlint\] index\.ts:\d+:\d+: error sshkeda\(no-unnamed-recovery\): Effect\.catch handles failures it does not name$/gmu,
        )?.length,
      ).toBe(TWICE);
      expect(printed).not.toContain("catchConditionalRefailToCatchIf");
      for (const duplicate of [
        "effect(globalConsole",
        "effect(globalDate",
        "effect(preferSchemaOverJson)",
        "no-disable-directives",
        "no-unnecessary-type-assertion",
        "disable this diagnostic",
        "Use `unknown`",
        "Delete this console statement",
        "node(no-sync)",
      ]) {
        expect(printed).not.toContain(duplicate);
      }
    }),
  ),
);

export const typeCheckIgnoresCheckScriptsAboveTheTemporaryDirectory = Task.make(
  "type-check runs bun's own checker even when a package.json above the temporary directory has a check script",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const shadowingParent = yield* fileSystem.makeTempDirectoryScoped();
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const temporaryDirectory = path.join(shadowingParent, "tmp");
      yield* fileSystem.makeDirectory(temporaryDirectory);
      yield* fileSystem.writeFileString(
        path.join(shadowingParent, "package.json"),
        `${yield* encodeIndentedJson({ name: "shadowing", scripts: { check: "echo SHADOWED" } })}\n`,
      );
      yield* linkNodeModulesWithCheck(directory);
      const files = {
        ".gitignore": "node_modules\nrun.ts\n",
        "package.json": `${yield* encodeIndentedJson({ name: path.basename(directory), type: "module" })}\n`,
        "tsconfig.json": `${yield* encodeIndentedJson(STRICT_INDEX_TSCONFIG)}\n`,
        "index.ts": "export const COUNT: number = 1;\n",
        "run.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { typeCheck } from ${yield* encodeJson(TYPE_CHECK_TASK)};\nTask.main(typeCheck);\n`,
      };
      for (const [file, text] of Object.entries(files)) {
        yield* fileSystem.writeFileString(path.join(directory, file), text);
      }
      yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
      const temporaryDirectoryJson = yield* encodeJson(temporaryDirectory);
      const typeCheckIn = () =>
        runTaskFile(`TMPDIR=${temporaryDirectoryJson} bun run.ts`, {
          cwd: directory,
          taskStateDirectory,
        }).pipe(
          Effect.catchTag("CommandFailed", (failure) =>
            Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
          ),
        );
      expect(yield* typeCheckIn()).toContain("[type-check] passed");
      yield* fileSystem.writeFileString(
        path.join(directory, "index.ts"),
        'export const COUNT: number = "one";\n',
      );
      const failed = yield* typeCheckIn();
      expect(failed).toMatch(/^\[type-check\] index\.ts:1:14: error TS2322: /mu);
      expect(failed).not.toContain("SHADOWED");
    }),
  ),
);

const fullCheckOutputWith = (
  projectFiles: Readonly<Record<string, string>>,
  symlinksBesideTheProject: readonly (readonly [target: string, link: string])[] = [],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const project = path.join(directory, "project");
    const taskStateDirectory = path.join(directory, "state");
    for (const [target, link] of symlinksBesideTheProject) {
      yield* fileSystem.symlink(target, path.join(directory, link));
    }
    yield* fileSystem.makeDirectory(project);
    yield* linkNodeModulesWithCheck(project);
    const files = {
      ".gitignore": "node_modules\nrun.ts\noxlint.config.ts\noxfmt.config.ts\n",
      "oxlint.config.ts": `import { lintConfig } from "@sshkeda/check";\nexport default lintConfig({});\n`,
      "oxfmt.config.ts": FORMAT_CONFIG_TEXT,
      "package.json": `${yield* encodeIndentedJson({ name: "project", type: "module", main: "./index.ts" })}\n`,
      "tsconfig.json": `${yield* encodeIndentedJson(STRICT_INDEX_TSCONFIG)}\n`,
      "index.ts": "export const COUNT = 1;\n",
      "run.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\nTask.main(check);\n`,
      ...projectFiles,
    };
    for (const [file, text] of Object.entries(files)) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(project, file)), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(project, file), text);
    }
    yield* Task.exec("git", ["init", "--quiet"], { cwd: project });
    return yield* runTaskFile("bun run.ts", { cwd: project, taskStateDirectory }).pipe(
      Effect.as(""),
      Effect.catchTag("CommandFailed", (failure) =>
        Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
      ),
    );
  });

export const everyCheckNamesAnUnreadablePackageJson = Task.make(
  'a nested package.json whose name is no string, such as { "name": 5 }, is printed at its path with why on one line by every check that looks for the nested packages to check, the cached checks whose inputs list them included, and the typed checks wait for the TypeScript config check it fails',
  Effect.scoped(
    Effect.gen(function* () {
      const failures = yield* fullCheckOutputWith({ "sub/package.json": '{ "name": 5 }\n' });
      const printed = failures
        .split("\n")
        .filter((line) => line.includes("PackageManifestUnreadable") && line.startsWith("["));
      expect(printed.toSorted()).toEqual(
        [
          "bun-fmt",
          "duplicate-functions",
          "file-types",
          "formatter-files",
          "layout",
          "lint-config",
          "typescript-config",
        ].map(
          (check) =>
            `[${check}] sub/package.json: error PackageManifestUnreadable: cannot be read as a package.json whose name, if any, is a string: Expected string at ["name"]`,
        ),
      );
      expect(failures).not.toMatch(/^\[[^\]]+\]\s+at \[/mu);
    }),
  ),
);

export const aPathThroughAFileOrASymlinkLoopFindsNoPackageJson = Task.make(
  "an import through a file, such as ./a.ts/b.ts, or through a symlink loop beside the project finds no package.json there, so every check reads it as a missing file that the type check reports as TS2307, not as a package.json that cannot be read",
  Effect.scoped(
    Effect.gen(function* () {
      const failures = yield* fullCheckOutputWith(
        {
          "a.ts": "export const A = 1;\n",
          "index.ts":
            'import { B } from "./a.ts/b.ts";\nimport { C } from "../loop/c.ts";\nexport { D } from "../loop/d.ts";\nexport const COUNT = [B, C];\n',
        },
        [["loop", "loop"]],
      );
      const errors = failures.split("\n").filter((line) => /^\[[^\]]+\] .*\berror\b/u.test(line));
      expect(
        errors.filter((line) =>
          /package\.json|ModuleRequestUnresolvable|cannot be judged/u.test(line),
        ),
      ).toEqual([]);
      expect(errors.filter((line) => line.includes("error TS2307"))).toEqual(
        [
          ["1", "./a.ts/b.ts"],
          ["2", "../loop/c.ts"],
          ["3", "../loop/d.ts"],
        ].map(
          ([line, request]) =>
            `[type-check] index.ts:${line}:19: error TS2307: Cannot find module '${request}' or its corresponding type declarations.`,
        ),
      );
    }),
  ),
);

export const exceptionalFileTypeHasOneRecoveryDiagnostic = Task.make(
  "the full Check CLI prints one file-type diagnostic with its exact path and only the fact",
  Effect.scoped(
    Effect.gen(function* () {
      const output = yield* fullCheckOutputWith({ "src/native.c": "" });
      const failures = output
        .split("\n")
        .filter((line) => line.startsWith("[file-types] src/native.c: error FileTypeNotGranted:"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBe(
        "[file-types] src/native.c: error FileTypeNotGranted: has file type .c, which is not allowed by default",
      );
    }),
  ),
);
