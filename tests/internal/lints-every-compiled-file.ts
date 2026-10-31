import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  programFiles,
  openTypeScriptProjects,
} from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import {
  makeProject as makeProjectWith,
  RUNNER,
  stagedCheckModule,
} from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const TYPE_CHECK_TASK = stagedCheckModule("src/lib/tasks/lib/type-check-with-bun-check/index.ts");

const OXLINT_TASK = stagedCheckModule("src/lib/tasks/lib/lint-with-oxlint/index.ts");
const LINTED_FILES_TYPE_CHECKED_TASK = stagedCheckModule(
  "src/lib/tasks/lib/require-type-checking-every-linted-file/index.ts",
);

const REFERENCED_PROJECT = {
  extends: "../tsconfig.json",
  compilerOptions: {
    composite: true,
    noEmit: false,
    emitDeclarationOnly: true,
    outDir: "../.referenced-declarations",
  },
  include: ["*.ts"],
} as const;

const taskRunIn = (
  directory: string,
  taskStateDirectory: string,
  name: string,
  taskModule: string,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(
      path.join(directory, `run-${name}.ts`),
      `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { ${name} } from ${yield* encodeJson(taskModule)};\nTask.main(${name});\n`,
    );
    return yield* runTaskFile(`bun run-${name}.ts`, {
      cwd: directory,
      taskStateDirectory,
    });
  });

const failedTaskOutput = (
  directory: string,
  taskStateDirectory: string,
  name: string,
  taskModule: string,
) =>
  taskRunIn(directory, taskStateDirectory, name, taskModule).pipe(
    failureAsValue,
    Effect.map((failure) => failure.message),
  );

const projectWithReferencedIgnoredFile = Effect.gen(function* () {
  return yield* makeProject(
    {
      "main.ts": 'import { HELPER } from "./outside/helper.ts";\nexport const MAIN = HELPER;\n',
      "outside/helper.ts": "export const HELPER = 1;\n",
      "ignored.ts": 'export const spawned = () => Bun.spawn(["git"]);\n',
      "ignored-globals.d.ts": "declare global {\n  var spawned: number;\n}\nexport {};\n",
      "referenced/tsconfig.json": yield* encodeJson(REFERENCED_PROJECT),
      "referenced/referenced.ts":
        'export const spawned = () => Bun.spawn(["git"]);\nexport const COUNT: number = "one";\n',
      ".gitignore":
        "node_modules\nignored.ts\nignored-globals.d.ts\n.referenced-declarations\nrun-*.ts\n",
    },
    "lintConfig({})",
    {
      include: ["main.ts", "ignored.ts", "ignored-globals.d.ts", "oxlint.config.ts"],
      references: [{ path: "./referenced" }],
    },
  );
});

export const programFilesFollowEveryImport = Task.make(
  "the compiled file set includes imported files outside include, gitignored files, project declaration files and referenced projects",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* projectWithReferencedIgnoredFile;
    expect(yield* programFiles(tsconfigFile)).toEqual([
      "ignored-globals.d.ts",
      "ignored.ts",
      "main.ts",
      "outside/helper.ts",
      "oxlint.config.ts",
      "referenced/referenced.ts",
    ]);
  }).pipe(Effect.scoped),
);

export const typedChecksReadReferencedProjectFiles = Task.make(
  "the typed checks find each compiled file, including referenced project files, in its project",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* projectWithReferencedIgnoredFile;
    const projects = yield* openTypeScriptProjects(tsconfigFile);
    expect(
      projects
        .flatMap(({ sourceFiles }) => sourceFiles.map(({ displayName }) => displayName))
        .toSorted(),
    ).toEqual([
      "ignored.ts",
      "main.ts",
      "outside/helper.ts",
      "oxlint.config.ts",
      "referenced/referenced.ts",
    ]);
  }).pipe(Effect.scoped),
);

export const libraryFilesNeitherListedNorOutsideTheProject = Task.make(
  "TypeScript library and @types files outside the project directory are not listed and do not make the project count as outside its directory",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      { "main.ts": "export const MAIN = Bun.version;\n" },
      "lintConfig({})",
      {
        include: [],
        files: ["main.ts"],
      },
    );
    expect(yield* programFiles(tsconfigFile)).toEqual(["main.ts"]);
  }).pipe(Effect.scoped),
);

export const aProjectInsideANodeModulesDirectoryStillListsItsOwnFiles = Task.make(
  "a project that lives inside a node_modules directory lists its own files and still treats the node_modules directories inside it as libraries",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installedParent = path.join(
      yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped()),
      "node_modules",
    );
    yield* fileSystem.makeDirectory(installedParent);
    const { tsconfigFile } = yield* makeProject(
      { "main.ts": "export const MAIN = Bun.version;\n" },
      "lintConfig({})",
      {},
      installedParent,
    );
    expect(yield* programFiles(tsconfigFile)).toEqual(["main.ts", "oxlint.config.ts"]);
    const projects = yield* openTypeScriptProjects(tsconfigFile);
    expect(
      projects
        .flatMap(({ sourceFiles }) => sourceFiles.map(({ displayName }) => displayName))
        .toSorted(),
    ).toEqual(["main.ts", "oxlint.config.ts"]);
  }).pipe(Effect.scoped),
);

export const projectCompilingOnlyOutsideItsDirectoryFailsLoudly = Task.make(
  "a project whose compiled files all lie outside its directory fails with ProgramFilesOutsideProject instead of checking nothing",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory } = yield* makeProject(
      { "nested/tsconfig.json": "{}", "main.ts": "export const MAIN = 1;\n" },
      "lintConfig({})",
      {
        include: [],
        files: ["main.ts"],
      },
    );
    const nestedProject = path.join(directory, "nested/tsconfig.json");
    yield* fileSystem.writeFileString(
      nestedProject,
      yield* encodeJson({ extends: "../tsconfig.json", files: ["../main.ts"] }),
    );
    const failure = yield* programFiles(nestedProject).pipe(failureAsValue);
    expect(failure._tag).toBe("ProgramFilesOutsideProject");
    expect(failure.message).toContain(path.join(directory, "main.ts"));
    expect(failure.message).not.toContain("node_modules");
  }).pipe(Effect.scoped),
);

export const referencedGitignoredFilesAreChecked = Task.make(
  "oxlint and type-check cover gitignored files, declaration files among them, and referenced projects",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* projectWithReferencedIgnoredFile;
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{"name":"covered"}\n');
    const linted = yield* failedTaskOutput(directory, taskStateDirectory, "oxlint", OXLINT_TASK);
    expect(linted).toContain("ignored.ts:1:30: error sshkeda(no-command-spawn)");
    expect(linted).toContain("referenced/referenced.ts:1:30: error sshkeda(no-command-spawn)");
    expect(linted).toContain("ignored-globals.d.ts:1:1: error sshkeda(no-type-declarations)");
    const typeChecked = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "typeCheck",
      TYPE_CHECK_TASK,
    );
    expect(typeChecked).toContain("[type-check] referenced/referenced.ts:2:14: error TS2322");
  }).pipe(Effect.scoped),
);

const projectImportingIgnoredJavaScriptWithDeclarations = () =>
  makeProject(
    {
      "src/main.ts": 'import { start } from "./engine.js";\n\nexport const main = () => start();\n',
      "src/engine.js": 'export const start = () => Bun.spawn(["git"]);\n',
      "src/engine.d.ts": "export declare const start: () => void;\n",
      ".gitignore": "node_modules\nrun-*.ts\nsrc/engine.js\n",
    },
    "lintConfig({})",
    {
      compilerOptions: {
        strict: true,
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        types: [],
        ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      },
      include: ["src/**/*.ts", "oxlint.config.ts"],
    },
  );

export const ignoredJavaScriptWithDeclarationsIsLinted = Task.make(
  "oxlint checks an imported gitignored JavaScript implementation even when TypeScript selects its sibling declaration",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } =
      yield* projectImportingIgnoredJavaScriptWithDeclarations();
    const printed = yield* failedTaskOutput(directory, taskStateDirectory, "oxlint", OXLINT_TASK);
    expect(printed).toContain("src/engine.js:1:28: error sshkeda(no-command-spawn)");
    expect(printed).not.toContain("TaskCalledLocationOperations");
  }).pipe(Effect.scoped),
);

export const ignoredJavaScriptWithDeclarationsNeedsTypeChecking = Task.make(
  "the coverage guard rejects an imported gitignored JavaScript implementation when TypeScript compiles only its declaration",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } =
      yield* projectImportingIgnoredJavaScriptWithDeclarations();
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain("src/engine.js: error LintedFileOutsideTypeScriptProgram");
    expect(printed).not.toContain("TaskCalledLocationOperations");
  }).pipe(Effect.scoped),
);

const projectCompilingSomeLintedFiles = (
  compilerOptions: Readonly<Record<string, boolean>>,
  lintConfig = "lintConfig({})",
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      {
        "main.ts": "export const MAIN = 1;\n",
        "outside.ts": "export const OUTSIDE = 1;\n",
        "script.js": "export const SCRIPT = 1;\n",
        "checked.js": "// @ts-check\nexport const CHECKED = 1;\n",
        "globals.d.ts": "export declare const GLOBAL: number;\n",
        "styles.d.css.ts": "export declare const STYLES: string;\n",
        ".gitignore": "node_modules\nrun-*.ts\n",
      },
      lintConfig,
      {
        compilerOptions: {
          strict: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          allowJs: true,
          types: [],
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          ...compilerOptions,
        },
        include: [],
        files: [
          "main.ts",
          "script.js",
          "checked.js",
          "globals.d.ts",
          "styles.d.css.ts",
          "oxlint.config.ts",
        ],
      },
    );
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{"name":"partly"}\n');
    return { directory, taskStateDirectory };
  });

export const lintedFilesTheTypeCheckSkipsFail = Task.make(
  "a linted file no program compiles, a JavaScript file compiled without checkJs and a declaration file compiled with skipLibCheck each fail, since the type checker and effect-tsgo would not check them",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* projectCompilingSomeLintedFiles({
      skipLibCheck: true,
    });
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain(
      "outside.ts: error LintedFileOutsideTypeScriptProgram: must be type-checked, but no program of tsconfig.json compiles it",
    );
    expect(printed).toMatch(
      /\] script\.js: error LintedJavaScriptFileNotTypeChecked: must be type-checked, but tsconfig\.json compiles it without checking JavaScript$/mu,
    );
    expect(printed).toMatch(
      /\] checked\.js: error LintedJavaScriptFileNotTypeChecked: must be type-checked, but tsconfig\.json compiles it without checking JavaScript$/mu,
    );
    expect(printed).toContain(
      "globals.d.ts: error LintedDeclarationFileNotTypeChecked: must be type-checked, but tsconfig.json compiles it without checking declaration files",
    );
    expect(printed).toContain(
      "styles.d.css.ts: error LintedDeclarationFileNotTypeChecked: must be type-checked, but tsconfig.json compiles it without checking declaration files",
    );
    expect(printed).not.toMatch(/main\.ts: error|oxlint\.config\.ts: error/u);
  }).pipe(Effect.scoped),
);

export const generatedSourceTheTypeCheckSkipsFails = Task.make(
  "generated source files must be type-checked like any other source file, but generated declaration files need not be",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* projectCompilingSomeLintedFiles(
      { skipLibCheck: true },
      'lintConfig({ "outside.ts": { allow: [{ isGeneratedByATool: "written by a code generator" }] }, "script.js": { allow: [{ isGeneratedByATool: "written by a code generator" }] }, "globals.d.ts": { allow: [{ isGeneratedByATool: "written by a code generator" }] }, "styles.d.css.ts": { allow: [{ isGeneratedByATool: "written by a code generator" }] } })',
    );
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain("outside.ts: error LintedFileOutsideTypeScriptProgram");
    expect(printed).toContain("script.js: error LintedJavaScriptFileNotTypeChecked");
    expect(printed).not.toMatch(/globals\.d\.ts: error|styles\.d\.css\.ts: error/u);
  }).pipe(Effect.scoped),
);

export const lintedFilesTheTypeCheckCoversPass = Task.make(
  "JavaScript files compiled with checkJs and declaration files compiled without skipLibCheck count as type-checked",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* projectCompilingSomeLintedFiles({
      checkJs: true,
      skipLibCheck: false,
    });
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain("outside.ts: error LintedFileOutsideTypeScriptProgram");
    expect(printed).not.toContain("script.js: error");
    expect(printed).not.toContain("checked.js: error");
    expect(printed).not.toContain("globals.d.ts: error");
    expect(printed).not.toContain("styles.d.css.ts: error");
  }).pipe(Effect.scoped),
);

export const referencedProjectsThatSkipLintedFilesFail = Task.make(
  "a referenced project that compiles a JavaScript file without checkJs or a declaration file with skipLibCheck fails, naming the referenced tsconfig",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      {
        "referenced/tsconfig.json": yield* encodeJson({
          extends: "../tsconfig.json",
          compilerOptions: {
            composite: true,
            noEmit: false,
            emitDeclarationOnly: true,
            outDir: "../.referenced-declarations",
            allowJs: true,
            checkJs: false,
            skipLibCheck: true,
          },
          include: ["*.js", "*.d.ts"],
        }),
        "referenced/script.js": "export const SCRIPT = 1;\n",
        "referenced/globals.d.ts": "export declare const GLOBAL: number;\n",
        ".gitignore": "node_modules\nrun-*.ts\n.referenced-declarations\n",
      },
      "lintConfig({})",
      { include: ["*.ts"], references: [{ path: "./referenced" }] },
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "package.json"),
      '{"name":"referenced"}\n',
    );
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain(
      "referenced/script.js: error LintedJavaScriptFileNotTypeChecked: must be type-checked, but referenced/tsconfig.json compiles it without checking JavaScript",
    );
    expect(printed).toContain(
      "referenced/globals.d.ts: error LintedDeclarationFileNotTypeChecked: must be type-checked, but referenced/tsconfig.json compiles it without checking declaration files",
    );
  }).pipe(Effect.scoped),
);

export const aDeclarationFileOneProjectChecksPasses = Task.make(
  "a declaration file passes when one project compiles it with skipLibCheck and another compiles it without",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      {
        "server/tsconfig.json": yield* encodeJson({
          compilerOptions: {
            composite: true,
            skipLibCheck: true,
            types: [],
            ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          },
          files: ["main.ts", "../shared/shapes.d.ts"],
        }),
        "server/main.ts": "export const MAIN = 1;\n",
        "web/tsconfig.json": yield* encodeJson({
          compilerOptions: {
            composite: true,
            types: [],
            ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          },
          files: ["main.ts", "../shared/shapes.d.ts"],
        }),
        "web/main.ts": "export const MAIN = 1;\n",
        "shared/shapes.d.ts": "export declare const SHAPE: number;\n",
        "stray.ts": "export const STRAY = 1;\n",
        ".gitignore": "node_modules\nrun-*.ts\n",
      },
      "lintConfig({})",
      {
        files: ["oxlint.config.ts"],
        include: [],
        references: [{ path: "./server" }, { path: "./web" }],
      },
    );
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{"name":"shared"}\n');
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain("stray.ts: error LintedFileOutsideTypeScriptProgram");
    expect(printed).not.toContain("shapes.d.ts: error");
  }).pipe(Effect.scoped),
);

export const configFilesCheckLoadsMustBeCompiled = Task.make(
  "oxlint.config.ts fails linted-files-type-checked when the tsconfig does not include it, since check loads it and lints it like any other file",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      { "src/index.ts": "export const MAIN = 1;\n", ".gitignore": "node_modules\nrun-*.ts\n" },
      "lintConfig({})",
      { include: ["src/**/*.ts"] },
    );
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{"name":"config"}\n');
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain(
      "oxlint.config.ts: error LintedFileOutsideTypeScriptProgram: must be type-checked, but no program of tsconfig.json compiles it",
    );
    expect(printed).not.toContain("src/index.ts: error");
  }).pipe(Effect.scoped),
);

export const javaScriptWithJsxIsJudgedWithoutParsingIt = Task.make(
  "a .js file with JSX that a project compiles under allowJs and jsx preserve without checkJs is reported as not type-checked instead of crashing the task",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      { "view.js": "export const VIEW = <div />;\n", ".gitignore": "node_modules\nrun-*.ts\n" },
      "lintConfig({})",
      {
        compilerOptions: {
          strict: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          allowJs: true,
          jsx: "preserve",
          types: [],
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
        },
        include: [],
        files: ["view.js", "oxlint.config.ts"],
      },
    );
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{"name":"jsx"}\n');
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain("view.js: error LintedJavaScriptFileNotTypeChecked");
    expect(printed).not.toContain("SourceFileUnparsable");
  }).pipe(Effect.scoped),
);

export const aFileCompiledThroughASymlinkPasses = Task.make(
  "a linted file that a project compiles through a symlink to it is not reported as outside the program",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      {
        "lib/real.ts": "export const REAL = 1;\n",
        "stray.ts": "export const STRAY = 1;\n",
        ".gitignore": "node_modules\nrun-*.ts\n",
      },
      "lintConfig({})",
      { include: ["src/**/*.ts", "oxlint.config.ts"] },
    );
    yield* fileSystem.makeDirectory(path.join(directory, "src"));
    yield* fileSystem.symlink("../lib/real.ts", path.join(directory, "src/link.ts"));
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{"name":"linked"}\n');
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain("stray.ts: error LintedFileOutsideTypeScriptProgram");
    expect(printed).not.toMatch(/(?:lib\/real|src\/link)\.ts: error/u);
  }).pipe(Effect.scoped),
);

export const retargetingADirectoryLinkRerunsTheCheck = Task.make(
  "retargeting a gitignored directory symlink that a project compiles through reruns linted-files-type-checked instead of reusing its cached pass",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      {
        "lib/real.ts": "export const REAL = 1;\n",
        "other/real.ts": "export const REAL = 1;\n",
        ".gitignore": "node_modules\nrun-*.ts\nsrc/gen\nother\n",
      },
      "lintConfig({})",
      { include: ["src/**/*.ts", "oxlint.config.ts"] },
    );
    yield* fileSystem.makeDirectory(path.join(directory, "src"));
    yield* fileSystem.symlink("../lib", path.join(directory, "src/gen"));
    yield* fileSystem.writeFileString(
      path.join(directory, "package.json"),
      '{"name":"retarget"}\n',
    );
    yield* taskRunIn(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    yield* fileSystem.remove(path.join(directory, "src/gen"));
    yield* fileSystem.symlink("../other", path.join(directory, "src/gen"));
    const printed = yield* failedTaskOutput(
      directory,
      taskStateDirectory,
      "lintedFilesTypeChecked",
      LINTED_FILES_TYPE_CHECKED_TASK,
    );
    expect(printed).toContain("lib/real.ts: error LintedFileOutsideTypeScriptProgram");
  }).pipe(Effect.scoped),
);

export const staticImportCyclesFailTheLint = Task.make(
  "a two-file static import cycle fails check's oxlint task with import(no-cycle), since placement leaves cycles to that rule",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* makeProject({
      "package.json": '{"name":"cycle"}\n',
      "first.ts": 'import { SECOND } from "./second.ts";\nexport const FIRST = () => SECOND;\n',
      "second.ts": 'import { FIRST } from "./first.ts";\nexport const SECOND = () => FIRST;\n',
      ".gitignore": "node_modules\nrun-*.ts\n",
    });
    const linted = yield* failedTaskOutput(directory, taskStateDirectory, "oxlint", OXLINT_TASK);
    expect(linted).toMatch(/first\.ts:1:\d+: error import\(no-cycle\)/u);
    expect(linted).toMatch(/second\.ts:1:\d+: error import\(no-cycle\)/u);
  }).pipe(Effect.scoped),
);

const COMPOSITE_PROJECT = {
  compilerOptions: {
    composite: true,
    strict: true,
    emitDeclarationOnly: true,
    outDir: "dist",
    module: "NodeNext",
    ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
  },
  include: ["*.ts"],
} as const;

export const referencesThatImportEachOtherAreTypeCheckedFromSource = Task.make(
  "type-check follows project references that import each other from source, with no build output, and reports the error at its path in the package",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, taskStateDirectory } = yield* makeProject(
      {
        "first/tsconfig.json": yield* encodeJson(COMPOSITE_PROJECT),
        "first/index.ts": "export const FIRST: number = 1;\n",
        "second/tsconfig.json": yield* encodeJson({
          ...COMPOSITE_PROJECT,
          references: [{ path: "../first" }],
        }),
        "second/index.ts":
          'import { FIRST } from "../first/index.js";\nexport const SECOND: string = FIRST;\n',
        ".gitignore": "node_modules\nrun-*.ts\ndist\n",
      },
      "lintConfig({})",
      {
        files: ["oxlint.config.ts"],
        include: [],
        references: [{ path: "./first" }, { path: "./second" }],
      },
    );
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{"name":"linked"}\n');
    yield* fileSystem.writeFileString(
      path.join(directory, "run-type-check.ts"),
      `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { typeCheck } from ${yield* encodeJson(TYPE_CHECK_TASK)};\nTask.main(typeCheck);\n`,
    );
    const typeChecked = yield* runTaskFile("bun run-type-check.ts", {
      cwd: directory,
      taskStateDirectory,
    }).pipe(
      failureAsValue,
      Effect.map((failure) => failure.message),
    );
    expect(typeChecked).toMatch(/^\[type-check\] second\/index\.ts:2:\d+: error TS2322: /mu);
    expect(typeChecked).not.toMatch(/TS6305|TS6310/u);
    expect(yield* fileSystem.exists(path.join(directory, "first/dist"))).toBe(false);
  }).pipe(Effect.scoped),
);

const SPAWNING_SOURCE = 'export const spawned = () => Bun.spawn(["git"]);\n';

export const filesAnEslintIgnoreListsAreLinted = Task.make(
  "oxlint lints a file that .eslintignore lists, since check names every file it lints",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* makeProject({
      "package.json": '{"name":"ignoring"}\n',
      "src/listed.ts": SPAWNING_SOURCE,
      ".eslintignore": "src/listed.ts\n",
      ".gitignore": "node_modules\nrun-*.ts\n",
    });
    const linted = yield* failedTaskOutput(directory, taskStateDirectory, "oxlint", OXLINT_TASK);
    expect(linted).toContain("src/listed.ts:1:30: error sshkeda(no-command-spawn)");
  }).pipe(Effect.scoped),
);

const LINTED_FILE_COUNT = 1500;
const DIRECTORY_NAME_REPEATS = 4;
const DIRECTORY_DEPTH = 4;
const MORE_BYTES_THAN_ONE_COMMAND_TAKES = 1_100_000;
const LONG_DIRECTORY = [
  "src",
  ...Array.from(
    { length: DIRECTORY_DEPTH },
    () =>
      `${"a-directory-whose-name-makes-the-argument-list-long-".repeat(DIRECTORY_NAME_REPEATS)}end`,
  ),
].join("/");

export const aFileListLongerThanOneCommandTakesIsLintedInRuns = Task.make(
  "a package whose linted files make a longer argument list than one command can take is linted in several oxlint runs that together report the first and the last file",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = Array.from(
      { length: LINTED_FILE_COUNT },
      (_slot, index) => `${LONG_DIRECTORY}/file-${index}.ts`,
    );
    const spawningFiles = new Set([files[0], files.at(-1)]);
    const { directory, taskStateDirectory } = yield* makeProject({
      "package.json": '{"name":"long"}\n',
      ".gitignore": "node_modules\nrun-*.ts\n",
    });
    yield* fileSystem.makeDirectory(path.join(directory, LONG_DIRECTORY), { recursive: true });
    yield* Effect.forEach(
      files,
      (file, index) =>
        fileSystem.writeFileString(
          path.join(directory, file),
          spawningFiles.has(file) ? SPAWNING_SOURCE : `export const VALUE_${index} = ${index};\n`,
        ),
      { concurrency: 64 },
    );
    expect(files.reduce((bytes, file) => bytes + file.length + 1, 0)).toBeGreaterThan(
      MORE_BYTES_THAN_ONE_COMMAND_TAKES,
    );
    const linted = yield* failedTaskOutput(directory, taskStateDirectory, "oxlint", OXLINT_TASK);
    expect(linted).toContain(`${files[0]}:1:30: error sshkeda(no-command-spawn)`);
    expect(linted).toContain(`${files.at(-1)}:1:30: error sshkeda(no-command-spawn)`);
  }).pipe(Effect.scoped),
);
