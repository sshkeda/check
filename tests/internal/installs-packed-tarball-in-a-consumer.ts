import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { encodeIndentedJson } from "../shared/indented-json.ts";
import {
  packedTarballInto,
  peerDependenciesAtDevelopmentVersions,
} from "../shared/package-tarball.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const formatConfigText = encodeJson(packageJson.name).pipe(
  Effect.map((name) => `import { FORMAT_CONFIG } from ${name};\n\nexport default FORMAT_CONFIG;\n`),
);

const CHECK_COMMAND = `bunx ${packageJson.name}`;

const TASK_DEPENDENCY = { "@sshkeda/task": packageJson.dependencies["@sshkeda/task"] };

const startTheCheckCommandText = encodeJson(packageJson.name).pipe(
  Effect.map(
    (name) =>
      `import { Task } from "@sshkeda/task";\n\nexport const check = Task.make("check", Task.exec("bunx", [${name}]));\n`,
  ),
);

const CI_SCRIPT_TEXT =
  'import { Task } from "@sshkeda/task";\n\nimport { check } from "./internal/start-the-check-command.ts";\n\nif (import.meta.main) {\n  Task.main(check);\n}\n';

const DEFAULT_EXPORT_SCRIPT_TEXT =
  'import { check } from "./internal/start-the-check-command.ts";\n\nexport default check;\n';

const SCRIPT_FILES = ["scripts/ci.ts", "scripts/internal/start-the-check-command.ts"] as const;

const throughTheCheckTask = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.startsWith("[check] "))
    .map((line) => line.slice("[check] ".length))
    .join("\n");

const REPLACED_PACKAGE_LOCK_KEYS = ['"oxfmt@', '"@oxfmt/'] as const;

const GUIDE_IN_THE_PACKAGE = `node_modules/${packageJson.name}/docs/how-to-make-check-pass.md`;

const pointersToTheGuide = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("[check] read "));

const pointerTo = (guide: string) => `[check] read ${guide} before you change the code`;

const STRICTEST_OPTIONS_A_CONSUMER_MAY_TURN_ON = {
  noImplicitReturns: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noPropertyAccessFromIndexSignature: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
} as const;

export const runsChecksFromPackedTarball = Task.make(
  "the packed tarball runs type-aware checks after an isolated frozen install without scripts or a root tsgolint, typescript or @effect/tsgo dependency, points failed runs at the installed guide, and its shipped source type-checks under every strict compiler option a consumer may turn on",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const consumer = yield* fileSystem.makeTempDirectoryScoped();
      const options = { cwd: consumer };
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const tarball = yield* packedTarballInto(consumer);
      const peersAtDevelopmentVersions = yield* peerDependenciesAtDevelopmentVersions(
        packageJson.devDependencies,
        packageJson.peerDependencies,
        consumer,
        consumer,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "bunfig.toml"),
        '[install]\nlinker = "isolated"\n',
      );
      yield* fileSystem.writeFileString(path.join(consumer, ".gitignore"), "node_modules\n*.tgz\n");
      yield* fileSystem.writeFileString(
        path.join(consumer, "package.json"),
        `${yield* encodeIndentedJson({
          name: path.basename(consumer),
          type: "module",
          main: "./src/index.ts",
          dependencies: {
            [packageJson.name]: `file:./${path.basename(tarball)}`,
            ...peersAtDevelopmentVersions,
            ...TASK_DEPENDENCY,
            "@types/bun": packageJson.devDependencies["@types/bun"],
          },
        })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "tsconfig.json"),
        `${yield* encodeIndentedJson({
          compilerOptions: {
            strict: true,
            module: "Preserve",
            noEmit: true,
            skipLibCheck: true,
            types: ["bun"],
            ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          },
          files: ["src/index.ts", "oxlint.config.ts", "oxfmt.config.ts", ...SCRIPT_FILES],
        })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "oxlint.config.ts"),
        `import { lintConfig } from ${yield* encodeJson(packageJson.name)};\n\nexport default lintConfig({ "src/index.ts": { allow: ["writesToTheTerminal"] } });\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "oxfmt.config.ts"),
        yield* formatConfigText,
      );
      yield* fileSystem.makeDirectory(path.join(consumer, "scripts/internal"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(consumer, "scripts/ci.ts"), CI_SCRIPT_TEXT);
      yield* fileSystem.writeFileString(
        path.join(consumer, "scripts/internal/start-the-check-command.ts"),
        yield* startTheCheckCommandText,
      );
      const source = path.join(consumer, "src/index.ts");
      yield* fileSystem.makeDirectory(path.dirname(source), { recursive: true });
      yield* fileSystem.writeFileString(source, 'export const greeting = "hello";\n');
      const misnamedFile = path.join(consumer, "Notes.json");
      yield* fileSystem.writeFileString(misnamedFile, "{}\n");
      yield* Task.exec("bun", ["install", "--ignore-scripts"], options);
      const frozenLockfile = yield* fileSystem.readFileString(path.join(consumer, "bun.lock"));
      yield* fileSystem.remove(path.join(consumer, "node_modules"), { recursive: true });
      yield* Task.exec("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], options);
      expect(yield* fileSystem.readFileString(path.join(consumer, "bun.lock"))).toBe(
        frozenLockfile,
      );
      expect(yield* fileSystem.exists(path.join(consumer, "node_modules/oxlint-tsgolint"))).toBe(
        false,
      );
      expect(yield* fileSystem.exists(path.join(consumer, "node_modules/.bin/tsgolint"))).toBe(
        false,
      );
      for (const bundled of ["typescript", "@effect/tsgo"]) {
        expect(yield* fileSystem.exists(path.join(consumer, "node_modules", bundled))).toBe(false);
      }
      yield* Task.exec("git", ["init", "--quiet"], options);
      yield* Task.exec("bun", ["fmt", "."], options);
      const lockfile = yield* fileSystem.readFileString(path.join(consumer, "bun.lock"));
      expect(lockfile).toContain('"@oxlint/plugins@');
      expect(lockfile).toContain('"oxlint@');
      expect(lockfile).toContain('"oxlint-tsgolint@');
      for (const replaced of REPLACED_PACKAGE_LOCK_KEYS) {
        expect(lockfile).not.toContain(replaced);
      }
      const installed = path.join(
        yield* fileSystem.realPath(consumer),
        "node_modules",
        packageJson.name,
      );
      expect(yield* fileSystem.exists(path.join(installed, "src/lib/tasks/index.ts"))).toBe(true);
      expect(yield* fileSystem.exists(path.join(installed, "dist"))).toBe(false);
      const installedGuide = path.join(
        path.relative(yield* fileSystem.realPath(consumer), yield* fileSystem.realPath(installed)),
        "docs/how-to-make-check-pass.md",
      );
      const lintConfigFile = path.join(consumer, "oxlint.config.ts");
      const lintConfig = yield* fileSystem.readFileString(lintConfigFile);
      yield* fileSystem.writeFileString(
        lintConfigFile,
        lintConfig.replace('"src/index.ts"', '"src/*.ts"'),
      );
      const configMistake = yield* runTaskFile(CHECK_COMMAND, {
        ...options,
        taskStateDirectory,
      }).pipe(failureAsValue);
      expect(configMistake.message).toContain(
        '[lint-config] oxlint.config.ts: error MalformedGrant: "src/*.ts": is a glob',
      );
      expect(configMistake.message).toContain(
        "[oxlint] error AwaitedTaskFailed: lint-config failed",
      );
      expect(configMistake.message).not.toContain("/dist/");
      expect(pointersToTheGuide(configMistake.message)).toEqual([pointerTo(installedGuide)]);
      expect(yield* fileSystem.exists(path.join(consumer, installedGuide))).toBe(true);
      yield* fileSystem.writeFileString(lintConfigFile, lintConfig);
      yield* fileSystem.writeFileString(
        source,
        'export const greeting = "hello";\nexport const LABEL = String("label");\n',
      );
      const failure = yield* runTaskFile(CHECK_COMMAND, {
        ...options,
        taskStateDirectory,
      }).pipe(failureAsValue);
      expect(failure.message).toMatch(
        /^\[oxlint\] src\/index\.ts:1:14: error sshkeda\(no-loose-literal-constants\): const greeting/mu,
      );
      expect(failure.message).toMatch(
        /^\[oxlint\] src\/index\.ts:2:\d+: error typescript\(no-unnecessary-type-conversion\): /mu,
      );
      expect(failure.message).toContain(
        "[layout] Notes.json: error NotKebabCase: Notes.json is not kebab-case",
      );
      expect(pointersToTheGuide(failure.message)).toEqual([pointerTo(installedGuide)]);
      yield* fileSystem.remove(misnamedFile);
      yield* fileSystem.writeFileString(source, 'export const GREETING = "hello";\n');
      const passing = yield* runTaskFile(CHECK_COMMAND, {
        ...options,
        taskStateDirectory,
      });
      expect(passing).toContain("passed");
      expect(pointersToTheGuide(passing)).toEqual([]);
      yield* fileSystem.writeFileString(
        path.join(consumer, "tsconfig.json"),
        `${yield* encodeIndentedJson({
          compilerOptions: {
            strict: true,
            module: "Preserve",
            noEmit: true,
            skipLibCheck: true,
            types: ["bun"],
            ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
            ...STRICTEST_OPTIONS_A_CONSUMER_MAY_TURN_ON,
          },
          files: ["src/index.ts", "oxlint.config.ts", "oxfmt.config.ts", ...SCRIPT_FILES],
        })}\n`,
      );
      yield* Task.exec("bun", ["fmt", "tsconfig.json"], options);
      const strictest = yield* runTaskFile("bun scripts/ci.ts", {
        ...options,
        taskStateDirectory,
      });
      expect(throughTheCheckTask(strictest)).toContain("[type-check] passed");
      expect(strictest).toContain("passed");
    }),
  ),
);

export const installsPackedTarballInAHoistedWorkspacePackage = Task.make(
  "the packed tarball checks a workspace package whose dependencies are hoisted to the workspace root, with one script that calls Task.main and one whose default export is the check task, and a failed run points at the guide by its path from that package",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped();
      const consumer = path.join(workspace, "packages/app");
      const options = { cwd: workspace };
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const tarball = yield* packedTarballInto(workspace);
      const peersAtDevelopmentVersions = {
        ...(yield* peerDependenciesAtDevelopmentVersions(
          packageJson.devDependencies,
          packageJson.peerDependencies,
          workspace,
          consumer,
        )),
        "@types/bun": packageJson.devDependencies["@types/bun"],
      };
      yield* fileSystem.makeDirectory(path.join(consumer, "scripts/internal"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(workspace, "bunfig.toml"),
        '[install]\nlinker = "hoisted"\n',
      );
      yield* fileSystem.writeFileString(
        path.join(workspace, ".gitignore"),
        "node_modules\n*.tgz\n",
      );
      yield* fileSystem.writeFileString(
        path.join(workspace, "package.json"),
        `${yield* encodeIndentedJson({
          name: path.basename(workspace),
          private: true,
          workspaces: ["packages/*"],
        })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "package.json"),
        `${yield* encodeIndentedJson({
          name: "app",
          type: "module",
          main: "./src/index.ts",
          dependencies: {
            [packageJson.name]: `file:../../${path.basename(tarball)}`,
            ...peersAtDevelopmentVersions,
            ...TASK_DEPENDENCY,
          },
        })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "tsconfig.json"),
        `${yield* encodeIndentedJson({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["bun"],
            ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          },
          include: ["src/index.ts", "oxlint.config.ts", "oxfmt.config.ts", "scripts/**/*.ts"],
        })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "oxlint.config.ts"),
        `import { lintConfig } from ${yield* encodeJson(packageJson.name)};\n\nexport default lintConfig({});\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "oxfmt.config.ts"),
        yield* formatConfigText,
      );
      yield* fileSystem.writeFileString(path.join(consumer, "scripts/ci.ts"), CI_SCRIPT_TEXT);
      yield* fileSystem.writeFileString(
        path.join(consumer, "scripts/check.ts"),
        DEFAULT_EXPORT_SCRIPT_TEXT,
      );
      yield* fileSystem.writeFileString(
        path.join(consumer, "scripts/internal/start-the-check-command.ts"),
        yield* startTheCheckCommandText,
      );
      const source = path.join(consumer, "src/index.ts");
      yield* fileSystem.makeDirectory(path.dirname(source), { recursive: true });
      yield* fileSystem.writeFileString(source, 'export const greeting = "hello";\n');
      yield* Task.exec("bun", ["install"], options);
      expect(yield* fileSystem.exists(path.join(consumer, "node_modules"))).toBe(false);
      yield* Task.exec("git", ["init", "--quiet"], options);
      yield* Task.exec("bun", ["fmt", "."], options);
      const failure = yield* runTaskFile("bun packages/app/scripts/ci.ts", {
        ...options,
        taskStateDirectory,
      }).pipe(failureAsValue);
      const printedByCheck = throughTheCheckTask(failure.message);
      expect(printedByCheck).toContain(
        "[oxlint] src/index.ts:1:14: error sshkeda(no-loose-literal-constants)",
      );
      const hoistedGuide = path.join("../..", GUIDE_IN_THE_PACKAGE);
      expect(pointersToTheGuide(printedByCheck)).toEqual([pointerTo(hoistedGuide)]);
      expect(yield* fileSystem.exists(path.join(consumer, hoistedGuide))).toBe(true);
      yield* fileSystem.writeFileString(source, 'export const GREETING = "hello";\n');
      const passing = yield* runTaskFile("bun packages/app/scripts/ci.ts", {
        ...options,
        taskStateDirectory,
      });
      expect(throughTheCheckTask(passing)).toMatch(/^passed: /mu);
      expect(passing).toMatch(/^passed: 1 task, /mu);
      expect(pointersToTheGuide(throughTheCheckTask(passing))).toEqual([]);
    }),
  ),
);

export const formatsAPackedConsumerWithItsFormatConfig = Task.make(
  "in a packed-tarball consumer plain bun fmt fixes what check reports, after check passed, changing the installed FORMAT_CONFIG makes check list the file again",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const consumer = yield* fileSystem.makeTempDirectoryScoped();
      const options = { cwd: consumer };
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const tarball = yield* packedTarballInto(consumer);
      const peersAtDevelopmentVersions = yield* peerDependenciesAtDevelopmentVersions(
        packageJson.devDependencies,
        packageJson.peerDependencies,
        consumer,
        consumer,
      );
      const filesByPath = {
        ".gitignore": "node_modules\n*.tgz\n",
        "package.json": `${yield* encodeIndentedJson({
          name: path.basename(consumer),
          type: "module",
          main: "./src/index.ts",
          dependencies: {
            [packageJson.name]: `file:./${path.basename(tarball)}`,
            ...peersAtDevelopmentVersions,
            ...TASK_DEPENDENCY,
            "@types/bun": packageJson.devDependencies["@types/bun"],
          },
        })}\n`,
        "tsconfig.json": `${yield* encodeIndentedJson({
          compilerOptions: {
            strict: true,
            module: "Preserve",
            noEmit: true,
            skipLibCheck: true,
            types: ["bun"],
            ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          },
          files: ["src/index.ts", "oxlint.config.ts", "oxfmt.config.ts", ...SCRIPT_FILES],
        })}\n`,
        "oxlint.config.ts": `import { lintConfig } from ${yield* encodeJson(packageJson.name)};\n\nexport default lintConfig({});\n`,
        "oxfmt.config.ts": yield* formatConfigText,
        "scripts/ci.ts": CI_SCRIPT_TEXT,
        "scripts/internal/start-the-check-command.ts": yield* startTheCheckCommandText,
        "src/index.ts":
          'export   const GREETING="hello there, a line longer than forty characters"',
      };
      for (const [file, text] of Object.entries(filesByPath)) {
        yield* fileSystem.makeDirectory(path.dirname(path.join(consumer, file)), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(consumer, file), text);
      }
      yield* Task.exec("bun", ["install"], options);
      yield* Task.exec("git", ["init", "--quiet"], options);
      const checkOutput = runTaskFile(CHECK_COMMAND, {
        ...options,
        taskStateDirectory,
      }).pipe(
        Effect.catchTag("CommandFailed", (failure) =>
          Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
        ),
      );
      const unformattedSource = "[bun-fmt] src/index.ts: error UnformattedFile: is not formatted";
      const unformatted = yield* checkOutput;
      expect(unformatted).toContain(unformattedSource);
      yield* Task.exec("bun", ["fmt"], options);
      expect(yield* checkOutput).toContain("passed");
      const installedConfigs = path.join(
        consumer,
        "node_modules",
        packageJson.name,
        "src/internal/define-the-lint-plugin-and-configs.ts",
      );
      const installed = yield* fileSystem.readFileString(installedConfigs);
      expect(installed).toContain("printWidth: 100,");
      yield* fileSystem.remove(installedConfigs);
      yield* fileSystem.writeFileString(
        installedConfigs,
        installed.replace("printWidth: 100,", "printWidth: 40,"),
      );
      expect(yield* checkOutput).toContain(unformattedSource);
    }),
  ),
);
