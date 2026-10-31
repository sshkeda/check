import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";
import type { Schema } from "effect";

import {
  findFileLayoutViolations,
  manifestViolations,
  directoriesHoldingOnlyADirectory,
  directoryNameViolations,
  directoryShapeViolations,
  duplicateFileNameViolations,
  pathViolations,
  packageRootViolations,
  patchGrantViolations,
  permissionGrantViolations,
  sourceViolations,
} from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { loadedLintConfigIn } from "../../src/lib/tasks/shared/load-the-lint-config.ts";
import { bunPatchFileNameOf } from "../../src/lib/tasks/shared/match-granted-patch-files.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import {
  DIRECTORY,
  FILE_TYPE,
  PATCH,
} from "../../src/shared/record-and-grant-permissions-by-path.ts";
import { linkNodeModulesWithCheck, writtenFiles } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const RUNNABLE =
  'import { Task } from "@sshkeda/task";\nimport { build } from "./shared/build.ts";\n\nif (import.meta.main) {\n  Task.main(build);\n}\n';

const outside = (field: string, specifier: string, manifest = "package.json") =>
  `${manifest}: error DependencyOutsideRepository: ${field} points to ${specifier}, outside the repository`;

const nonScript = (path: string) =>
  `${path}: error TopLevelNonScript: sits directly in scripts/ and is not a TypeScript or JavaScript file`;

const withoutMain = (path: string) =>
  `${path}: error TopLevelScriptWithoutMain: sits directly in scripts/ and does not call Task.main imported from @sshkeda/task`;

const AT_REPOSITORY_ROOT = { root: "/repository", packageDirectory: "/repository" } as const;

export const acceptsConventionalPaths = Task.make(
  "kebab-case paths, tool-mandated and conventional names, files inside hidden directories with valid names and tests in tests pass the layout check",
  Effect.sync(() => {
    expect(
      [
        "package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "bun.lock",
        "bunfig.toml",
        "oxlint.config.ts",
        ".gitignore",
        ".github/workflows/ci.yml",
        "README.md",
        "docs/README.md",
        "docs/code-review.md",
        "docs/reviews/naming.md",
        "LICENSE",
        "src/index.ts",
        "src/main-thread/index.ts",
        "src/main-thread/lib/cache-sqlite.ts",
        "src/main-thread/lib/storage/sqlite.ts",
        "vite.config.ts",
        "src/components/index.tsx",
        "scripts/ci.ts",
        "scripts/shared/errors.ts",
        "tests/runs-tasks.ts",
        "tests/fixtures/sample.ts",
      ].flatMap((path) => taggedViolations(pathViolations(path))),
    ).toEqual([]);
  }),
);

export const rejectsMisplacedPaths = Task.make(
  "non-kebab names and non-scripts directly in scripts/ are reported while language restrictions belong to the file-type check",
  Effect.sync(() => {
    expect(taggedViolations(pathViolations("src/pool/workerPool.ts"))).toEqual([
      "src/pool/workerPool.ts: error NotKebabCase: workerPool.ts is not kebab-case",
    ]);
    for (const path of [".github/workflows/CI.yml", "src/.cache/BadName.ts"]) {
      const segment = path.split("/").at(-1);
      expect(taggedViolations(pathViolations(path))).toEqual([
        `${path}: error NotKebabCase: ${segment} is not kebab-case`,
      ]);
    }
    expect(taggedViolations(pathViolations(".BadTool/config.json"))).toEqual([
      ".BadTool/config.json: error NotKebabCase: .BadTool is not kebab-case",
    ]);
    expect(taggedViolations(pathViolations("src/Lib/index.ts"))).toEqual([
      "src/Lib/index.ts: error NotKebabCase: Lib is not kebab-case",
    ]);
    expect(taggedViolations(pathViolations("src/café/menu.ts"))).toEqual([
      "src/café/menu.ts: error NotKebabCase: café is not kebab-case",
    ]);
    for (const path of [
      "AGENTS.md",
      "CLAUDE.md",
      "docs/AGENTS.md",
      "src/CLAUDE.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "Makefile",
      ".github/CODEOWNERS",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".claude/skills/review/SKILL.md",
    ]) {
      const segment = path.split("/").at(-1);
      expect(taggedViolations(pathViolations(path))).toEqual([
        `${path}: error NotKebabCase: ${segment} is not kebab-case`,
      ]);
    }
    expect(taggedViolations(pathViolations("tools/setup.sh"))).toEqual([]);
    expect(taggedViolations(pathViolations("tools/report.py"))).toEqual([]);
    expect(taggedViolations(pathViolations("tools/deploy.bash"))).toEqual([]);
    expect(taggedViolations(pathViolations("src/__tests__/cache.ts")).join("\n")).toContain(
      "__tests__ is not kebab-case",
    );
    expect(
      ["scripts/settings.json", "scripts/README.md", "scripts/.env"].flatMap((path) =>
        taggedViolations(pathViolations(path)),
      ),
    ).toEqual([
      nonScript("scripts/settings.json"),
      nonScript("scripts/README.md"),
      nonScript("scripts/.env"),
    ]);
    expect(taggedViolations(pathViolations("scripts/shared/settings.json"))).toEqual([]);
  }),
);

const duplicate = (path: string, others: string, scope: string) =>
  `${path}: error DuplicateFileName: has the same file name as ${others} in ${scope}`;

export const sourceFileNamesAreUniqueInEachScope = Task.make(
  "two source files with the same name in one scope, whatever their script extension, are each reported; modules, scripts/, the test home and the package root are scopes, internal and shared/ directories are not, and index files may repeat",
  Effect.sync(() => {
    expect(
      taggedViolations(
        duplicateFileNameViolations([
          "src/index.ts",
          "src/shared/errors.ts",
          "src/rules/errors.ts",
          "src/tasks/index.ts",
          "src/tasks/errors.ts",
          "src/tasks/inner/index.tsx",
          "src/tasks/inner/errors.ts",
          "src/tasks/shared/Errors.ts",
          "scripts/ci.ts",
          "scripts/shared/errors.ts",
          "scripts/release/errors.ts",
          "tests/errors.ts",
          "tests/shared/ci.ts",
          "apps/web/index.ts",
          "apps/web/errors.ts",
          "apps/api/errors.ts",
          "tools/a/run.ts",
          "tools/b/run.ts",
          "tools/c/format.ts",
          "tools/d/format.tsx",
          "tools/e/format.mts",
          "docs/a/README.md",
          "docs/b/README.md",
        ]),
      ),
    ).toEqual([
      duplicate("src/shared/errors.ts", "src/rules/errors.ts", "src/"),
      duplicate("src/rules/errors.ts", "src/shared/errors.ts", "src/"),
      duplicate("scripts/shared/errors.ts", "scripts/release/errors.ts", "scripts/"),
      duplicate("scripts/release/errors.ts", "scripts/shared/errors.ts", "scripts/"),
      duplicate("tools/a/run.ts", "tools/b/run.ts", "the package root"),
      duplicate("tools/b/run.ts", "tools/a/run.ts", "the package root"),
      duplicate("tools/c/format.ts", "tools/d/format.tsx, tools/e/format.mts", "the package root"),
      duplicate("tools/d/format.tsx", "tools/c/format.ts, tools/e/format.mts", "the package root"),
      duplicate("tools/e/format.mts", "tools/c/format.ts, tools/d/format.tsx", "the package root"),
    ]);
  }),
);

export const libraryDirectoriesOutsideModulesAreReported = Task.make(
  "every lib/ directory below the package root that is not directly in a module is reported once, wherever it sits, while a root lib/ is left to MisplacedAtPackageRoot and a lib/ inside a directory outside the module layout is left to DirectoryOutsideModuleLayout",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoryShapeViolations([
          "src/index.ts",
          "src/lib/a/index.ts",
          "src/lib/a/lib/b/index.ts",
          "src/internal/lib/data.json",
          "src/lib/a/shared/lib/data.json",
          "scripts/lib/tests/c.ts",
          "tests/shared/lib/d.json",
          "lib/e.ts",
          ".github/lib/a.ts",
          "src/other/lib/f/index.ts",
        ]),
      ),
    ).toEqual([
      "src/other: error DirectoryOutsideModuleLayout: is a directory in the module src/ other than internal/, shared/ or lib/",
      ...[
        "src/internal/lib",
        "src/lib/a/shared/lib",
        "scripts/lib",
        "tests/shared/lib",
        ".github/lib",
      ].map(
        (path) =>
          `${path}: error LibraryDirectory: is a lib/ directory that is not directly in a module`,
      ),
    ]);
  }),
);

const outsideModuleLayout = (directory: string, module: string) =>
  `${directory}: error DirectoryOutsideModuleLayout: is a directory in the module ${module}/ other than internal/, shared/ or lib/`;

export const modulesHoldOnlyTheirIndexInternalSharedAndLibrary = Task.make(
  "src/, tests/ and every module in a lib/ below them may hold only its index, internal/, shared/ and lib/, so any other directory directly in one is DirectoryOutsideModuleLayout once, without reports for what it holds, while directories inside internal/ and shared/ and paths outside src/ and tests/ are left to other rules",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoryShapeViolations([
          "src/index.ts",
          "src/internal/a.ts",
          "src/shared/b.ts",
          "src/lib/tasks/index.ts",
          "src/lib/tasks/internal/c.ts",
          "src/lib/tasks/lib/layout/index.tsx",
          "src/lib/tasks/lib/layout/shared/d.ts",
          "src/lib/tasks/lib/layout/lib/deep/index.ts",
          "src/tasks/index.ts",
          "src/tasks/lib/inner/index.ts",
          "src/assets/logo.svg",
          "src/lib/tasks/helpers/e.ts",
          "src/lib/tasks/lib/layout/lib/deep/fixtures/f.json",
          "src/lib/tasks/internal/assets/g.svg",
          "scripts/release/h.ts",
          "tests/index.ts",
          "tests/internal/i.ts",
          "tests/lib/unit/index.ts",
          "tests/fixtures/j.ts",
        ]),
      ),
    ).toEqual([
      outsideModuleLayout("src/tasks", "src"),
      outsideModuleLayout("src/assets", "src"),
      outsideModuleLayout("src/lib/tasks/helpers", "src/lib/tasks"),
      outsideModuleLayout(
        "src/lib/tasks/lib/layout/lib/deep/fixtures",
        "src/lib/tasks/lib/layout/lib/deep",
      ),
      outsideModuleLayout("tests/fixtures", "tests"),
    ]);
  }),
);

export const libraryDirectoriesHoldOnlyModules = Task.make(
  "a lib/ directory of a module holds only modules, so a file directly in it is FileInLibraryDirectory and a directory in it without an index.ts or index.tsx is ModuleWithoutIndex",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoryShapeViolations([
          "src/index.ts",
          "src/lib/index.ts",
          "src/lib/notes.md",
          "src/lib/a/index.ts",
          "src/lib/a/lib/loose.ts",
          "src/lib/b/internal/x.ts",
          "src/lib/a/lib/c/shared/y.ts",
        ]),
      ),
    ).toEqual([
      "src/lib/b: error ModuleWithoutIndex: is a directory in src/lib/ without an index.ts or index.tsx",
      "src/lib/a/lib/c: error ModuleWithoutIndex: is a directory in src/lib/a/lib/ without an index.ts or index.tsx",
      "src/lib/index.ts: error FileInLibraryDirectory: is a file directly in src/lib/",
      "src/lib/notes.md: error FileInLibraryDirectory: is a file directly in src/lib/",
      "src/lib/a/lib/loose.ts: error FileInLibraryDirectory: is a file directly in src/lib/a/lib/",
    ]);
    expect(
      taggedViolations([
        ...sourceViolations("src/lib/loose.ts", "export const VALUE = 1;"),
        ...sourceViolations("src/lib/a/lib/loose.ts", "export const VALUE = 1;"),
      ]),
    ).toEqual([]);
  }),
);

const withLayoutDirectoryName = (module: string) =>
  `${module}: error ModuleWithLayoutDirectoryName: is a module in ${module.split("/").slice(0, -1).join("/")}/ named internal, shared or lib`;

export const libraryModulesCannotTakeLayoutDirectoryNames = Task.make(
  "a module in a lib/ named internal, shared or lib is ModuleWithLayoutDirectoryName, and no other shape error is reported inside it",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoryShapeViolations([
          "src/index.ts",
          "src/lib/shared/index.ts",
          "src/lib/shared/internal/value.ts",
        ]),
      ),
    ).toEqual([withLayoutDirectoryName("src/lib/shared")]);
    expect(
      taggedViolations(
        directoryShapeViolations([
          "src/index.ts",
          "src/lib/internal/index.ts",
          "src/lib/internal/shared/value.ts",
          "src/lib/lib/index.ts",
          "src/lib/lib/internal/value.ts",
          "src/lib/a/index.ts",
          "src/lib/a/lib/shared/internal/value.ts",
          "tests/index.ts",
          "tests/lib/lib/index.ts",
        ]),
      ),
    ).toEqual([
      withLayoutDirectoryName("src/lib/internal"),
      withLayoutDirectoryName("src/lib/lib"),
      withLayoutDirectoryName("src/lib/a/lib/shared"),
      withLayoutDirectoryName("tests/lib/lib"),
    ]);
  }),
);

const holdsOnly = (directory: string, child: string) =>
  `${directory}: error DirectoryHoldsOnlyADirectory: holds only the directory ${child}/`;

const NO_NESTED_PACKAGES = [] as const;

export const aDirectoryHoldingOnlyOneDirectoryIsReported = Task.make(
  "a directory whose only entry is one directory is reported",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          ["package.json", "src/memo/index.ts", "src/memo/a.ts"],
          NO_NESTED_PACKAGES,
        ),
      ),
    ).toEqual([holdsOnly("src", "memo")]);
  }),
);

export const aDirectoryHoldingTwoDirectoriesPasses = Task.make(
  "a directory holding two directories passes",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          ["package.json", "src/a/index.ts", "src/b/index.ts"],
          NO_NESTED_PACKAGES,
        ),
      ),
    ).toEqual([]);
  }),
);

export const aDirectoryHoldingOneDirectoryAndAFilePasses = Task.make(
  "a directory holding one directory and a file passes",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          ["package.json", "src/index.ts", "src/shared/a.ts"],
          NO_NESTED_PACKAGES,
        ),
      ),
    ).toEqual([]);
  }),
);

export const aLibraryDirectoryHoldingOneModulePasses = Task.make(
  "a lib/ directory of a module holding a single module passes, while src/ holding only lib/ is reported",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          [
            "package.json",
            "src/index.ts",
            "src/lib/tasks/index.ts",
            "src/lib/tasks/lib/layout/index.ts",
            "scripts/lib/only/a.ts",
          ],
          NO_NESTED_PACKAGES,
        ),
      ),
    ).toEqual([holdsOnly("scripts", "lib"), holdsOnly("scripts/lib", "only")]);
  }),
);

export const nestedWrapperDirectoriesAreEachReported = Task.make(
  "every level of nested wrapper directories is reported",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          ["package.json", "tests/a.ts", "src/a/b/c/index.ts", "src/a/b/c/d.ts"],
          NO_NESTED_PACKAGES,
        ),
      ),
    ).toEqual([holdsOnly("src", "a"), holdsOnly("src/a", "b"), holdsOnly("src/a/b", "c")]);
  }),
);

export const internalAndSharedDirectoriesHoldOnlyFiles = Task.make(
  "an internal/ or shared/ directory that holds a code directory, one holding a script outside tests/ at any depth, a module with an index.ts included, is DirectoryInInternalOrShared once per directory it holds, an index.ts or index.tsx directly in one is IndexInInternalOrShared, while other files directly in them, deeper directories and directories of documents, assets, data or test fixtures pass",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoryShapeViolations([
          "src/lib/store/index.ts",
          "src/lib/store/internal/read.ts",
          "src/lib/store/internal/parse/parse.ts",
          "src/lib/store/internal/parse/deep/deeper.ts",
          "src/lib/store/internal/job/index.ts",
          "src/shared/words.ts",
          "src/shared/plugins/plugin.ts",
          "tests/shared/fixtures/fixture.ts",
          "docs/internal/runbooks/deploy.md",
          "src/lib/ui/index.tsx",
          "src/lib/ui/shared/assets/logo.svg",
          "src/lib/ui/shared/fixtures/data.json",
          "src/lib/ui/internal/views/deep/view.tsx",
          "src/lib/web/index.ts",
          "src/lib/web/shared/.cache/entry.ts",
          ".github/actions/shared/index.ts",
          "src/lib/web/.cache/internal/index.ts",
          "src/lib/web/internal-tools/tool.ts",
          "src/lib/web/internal/index.tsx",
          "src/lib/web/shared/index.ts",
          "src/lib/web/shared/index-of-pages.ts",
        ]),
      ),
    ).toEqual([
      outsideModuleLayout("src/lib/web/.cache", "src/lib/web"),
      outsideModuleLayout("src/lib/web/internal-tools", "src/lib/web"),
      ...[
        ["src/lib/store/internal", "src/lib/store/internal/parse"],
        ["src/lib/store/internal", "src/lib/store/internal/job"],
        ["src/shared", "src/shared/plugins"],
        ["src/lib/ui/internal", "src/lib/ui/internal/views"],
        ["src/lib/web/shared", "src/lib/web/shared/.cache"],
      ].map(
        ([path, directory]) =>
          `${path}: error DirectoryInInternalOrShared: holds the directory ${directory}/`,
      ),
      ".github/actions/shared/index.ts: error IndexInInternalOrShared: is an index file directly in shared/",
      "src/lib/web/.cache/internal/index.ts: error IndexInInternalOrShared: is an index file directly in internal/",
      "src/lib/web/internal/index.tsx: error IndexInInternalOrShared: is an index file directly in internal/",
      "src/lib/web/shared/index.ts: error IndexInInternalOrShared: is an index file directly in shared/",
    ]);
  }),
);

export const hiddenDirectoriesHoldingOnlyADirectoryAreReported = Task.make(
  "hidden directories and their descendants follow the same rule against holding only one directory",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          [
            "package.json",
            ".github/workflows/ci.yml",
            ".claude/skills/review/SKILL.md",
            "src/index.ts",
          ],
          NO_NESTED_PACKAGES,
        ),
      ),
    ).toEqual([
      holdsOnly(".github", "workflows"),
      holdsOnly(".claude", "skills"),
      holdsOnly(".claude/skills", "review"),
    ]);
  }),
);

export const aNestedPackageCountsAsAnEntry = Task.make(
  "a nested package's root directory counts as an entry of the directory holding it, though its files are judged in that package's own run",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          ["package.json", "src/index.ts", "src/fixtures/data/a.json"],
          ["src/fixtures/pkg"],
        ),
      ),
    ).toEqual([]);
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(["package.json", "src/index.ts"], ["src/fixtures/pkg"]),
      ),
    ).toEqual([holdsOnly("src/fixtures", "pkg")]);
  }),
);

export const directoriesInsideANestedPackageAreNotChecked = Task.make(
  "directories inside a nested package belong to that package's layout, so a package holding another package is not reported",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoriesHoldingOnlyADirectory(
          ["package.json", "src/index.ts", "src/data/a.json"],
          ["src/pkg", "src/pkg/examples/inner"],
        ),
      ),
    ).toEqual([]);
  }),
);

const outsideImplementation = (path: string) =>
  `${path}: error SourceOutsideInternalOrShared: is a non-index source file outside internal/ or shared/`;

export const testsFollowTheModuleLayout = Task.make(
  "tests/ is a module, so its index and files in its internal/, its shared/ and its lib/ modules pass whether or not they make a task, while any other file in tests/ is SourceOutsideInternalOrShared",
  Effect.sync(() => {
    const test =
      'import { Task } from "@sshkeda/task";\nexport const passes = Task.make("passes", work);\n';
    const helper = "export const helper = 1;\n";
    expect(
      [
        sourceViolations("tests/index.ts", 'export { passes } from "./internal/passes.ts";\n'),
        sourceViolations("tests/internal/passes.ts", test),
        sourceViolations("tests/internal/helper.ts", helper),
        sourceViolations("tests/shared/helper.ts", helper),
        sourceViolations("tests/shared/fixtures/helper.ts", helper),
        sourceViolations("tests/lib/unit/index.ts", helper),
        sourceViolations("tests/lib/unit/internal/passes.ts", test),
      ].flatMap((violations) => taggedViolations(violations)),
    ).toEqual([]);
    expect(
      [
        sourceViolations("tests/passes.ts", test),
        sourceViolations("tests/support/declares.ts", test),
      ].flatMap((violations) => taggedViolations(violations)),
    ).toEqual([
      outsideImplementation("tests/passes.ts"),
      outsideImplementation("tests/support/declares.ts"),
    ]);
  }),
);

export const directoryNamesAreCheckedOnceEach = Task.make(
  "a retired word in a directory name is reported once for the directory, including inside hidden directories, while file names are left to oxlint",
  Effect.sync(() => {
    expect(
      taggedViolations(
        directoryNameViolations([
          "src/settings/a.ts",
          "src/settings/b.ts",
          "src/settings/nested/c.ts",
          "docs/findings.md",
          "src/scan/folder-scan.ts",
          ".github/workflows/ci.yml",
          ".vscode/settings.json",
          ".claude/settings.json",
          ".claude/settings/local.json",
        ]),
      ),
    ).toEqual([
      "src/settings: error RetiredWordInPath: uses the retired word settings",
      ".claude/settings: error RetiredWordInPath: uses the retired word settings",
    ]);
  }),
);

const holdsOtherStatement = (location: string) =>
  `${location}: error TopLevelScriptHoldsOtherStatement: holds a statement other than an import and if (import.meta.main) { Task.main(task); }`;

const guarded = (imports: string, call: string) =>
  `${imports}\n\nif (import.meta.main) {\n  ${call};\n}\n`;

export const scriptsMustRunTasks = Task.make(
  "a script directly in scripts/ calls Task.main imported from @sshkeda/task by name or through a namespace, or it is TopLevelScriptWithoutMain, while a script in a scripts/ subdirectory need not",
  Effect.sync(() => {
    expect(taggedViolations(sourceViolations("scripts/build.ts", RUNNABLE))).toEqual([]);
    expect(
      taggedViolations(
        sourceViolations(
          "scripts/build.ts",
          guarded(
            'import * as Tasks from "@sshkeda/task";\nimport { build } from "./shared/build.ts";',
            "Tasks.Task.main(build)",
          ),
        ),
      ),
    ).toEqual([]);
    expect(
      taggedViolations(sourceViolations("scripts/shared/helpers.ts", "export const helper = 1;\n")),
    ).toEqual([]);
    const notRunnable = withoutMain("scripts/helpers.ts");
    for (const helpers of [
      "export const helper = 1;\n",
      'import { run } from "./lib/run.ts";\nrun(build);\n',
      'import { Task } from "@sshkeda/task";\nexport { Task };\n',
    ]) {
      expect(taggedViolations(sourceViolations("scripts/helpers.ts", helpers))).toEqual([
        notRunnable,
      ]);
    }
  }),
);

export const scriptsHoldOnlyImportsAndTheirMainCall = Task.make(
  "a script directly in scripts/ that calls Task.main may hold only imports and one if (import.meta.main) { Task.main(task); } with a named task, so each other statement is TopLevelScriptHoldsOtherStatement, including a bare or aliased Task.main call, a declaration, an export, a second guard and a guard with more in it, while a script in a scripts/ subdirectory may hold anything",
  Effect.sync(() => {
    const TASK = 'import { Task } from "@sshkeda/task";';
    expect(
      taggedViolations(
        sourceViolations(
          "scripts/build.ts",
          guarded(
            `import type { Effect } from "effect";\n${TASK}\nimport { build } from "./shared/build.ts";`,
            "Task.main(build)",
          ),
        ),
      ),
    ).toEqual([]);
    expect(
      taggedViolations(sourceViolations("scripts/build.ts", `${TASK}\nTask.main(build);\n`)),
    ).toEqual([holdsOtherStatement("scripts/build.ts:2")]);
    expect(
      taggedViolations(
        sourceViolations(
          "scripts/build.ts",
          `${TASK}\nconst launch = Task.main;\nlaunch(build);\n`,
        ),
      ),
    ).toEqual([
      holdsOtherStatement("scripts/build.ts:2"),
      holdsOtherStatement("scripts/build.ts:3"),
    ]);
    expect(
      taggedViolations(
        sourceViolations(
          "scripts/ci.ts",
          [
            TASK,
            'export const ci = Task.make("ci", work);',
            "if (import.meta.main) {",
            "  Task.main(ci);",
            "}",
            "if (import.meta.main) {",
            "  Task.main(ci);",
            "}",
            "",
          ].join("\n"),
        ),
      ),
    ).toEqual([holdsOtherStatement("scripts/ci.ts:2"), holdsOtherStatement("scripts/ci.ts:6")]);
    for (const guard of [
      'if (import.meta.main) {\n  Task.main(Task.make("ci", work));\n}',
      "if (import.meta.main) {\n  Task.main(ci);\n  done();\n}",
      "if (import.meta.main) Task.main(ci);",
      "if (import.meta.main) {\n  Task.main(ci);\n} else {\n  done();\n}",
      "if (main) {\n  Task.main(ci);\n}",
    ]) {
      expect(
        taggedViolations(
          sourceViolations(
            "scripts/ci.ts",
            `${TASK}\nimport { ci } from "./shared/ci.ts";\n${guard}\n`,
          ),
        ),
      ).toEqual([holdsOtherStatement("scripts/ci.ts:3")]);
    }
    expect(
      taggedViolations(
        sourceViolations(
          "scripts/shared/ci.ts",
          `${TASK}\nexport const ci = Task.make("ci", work);\nTask.main(ci);\n`,
        ),
      ),
    ).toEqual([]);
  }),
);

const grantsOf = (granted: {
  readonly documents: readonly string[];
  readonly others: readonly string[];
}) => [
  ...granted.documents.map((path): Parameters<typeof permissionGrantViolations>[1][number] => ({
    path,
    allow: [FILE_TYPE],
    services: [],
    cannotImport: [],
  })),
  ...granted.others.map((path): Parameters<typeof permissionGrantViolations>[1][number] => ({
    path,
    allow: [],
    services: ["Store"],
    cannotImport: [],
  })),
];

const directoryGrantsOf = (directories: readonly string[]) =>
  directories.map((path): Parameters<typeof permissionGrantViolations>[1][number] => ({
    path,
    allow: [DIRECTORY],
    services: [],
    cannotImport: [],
  }));

const ungrantedDirectory = (directory: string) =>
  `${directory}: error UngrantedDirectory: is a directory outside the default layout that oxlint.config.ts does not allow`;

export const exceptionalDirectoriesNeedExactGrants = Task.make(
  "extra root directories need exact grants, while hidden and visible nested directories and dotfiles need none",
  Effect.sync(() => {
    const paths = [
      ".local-packages/check.tgz",
      ".local-packages/provenance.json",
      ".github/workflows/ci.yml",
      ".claude/settings.json",
      "src/.cache/data.json",
      "src/cache/data.json",
      ".github/.private/value.json",
      ".github-other/value.json",
      "vendor/acme.json",
      "vendor/.private/value.json",
      "vendor-copy/value.json",
      ".gitignore",
    ];
    const directories = [
      ".local-packages",
      ".github",
      ".claude",
      ".github-other",
      "vendor",
      "vendor-copy",
    ];
    expect(taggedViolations(permissionGrantViolations(paths, []))).toEqual(
      directories.map((directory) => ungrantedDirectory(directory)),
    );
    expect(
      taggedViolations(
        permissionGrantViolations(
          paths,
          directoryGrantsOf([".local-packages", ".github", ".claude", "vendor"]),
        ),
      ),
    ).toEqual([ungrantedDirectory(".github-other"), ungrantedDirectory("vendor-copy")]);
    expect(
      taggedViolations(permissionGrantViolations(paths, directoryGrantsOf(directories))),
    ).toEqual([]);
  }),
);

export const directoryGrantsDoNotGrantFilePermissions = Task.make(
  "a directory grant does not allow its documents, file permissions or services, and documents still need exact file grants",
  Effect.sync(() => {
    const paths = [".github/PULL_REQUEST_TEMPLATE.md", ".github/actions/run.ts"];
    expect(
      taggedViolations(permissionGrantViolations(paths, directoryGrantsOf([".github"]))),
    ).toEqual([
      ".github/PULL_REQUEST_TEMPLATE.md: error UngrantedDocument: is a document that oxlint.config.ts does not allow",
    ]);
    expect(
      taggedViolations(
        permissionGrantViolations(paths, [
          ...directoryGrantsOf([".github"]),
          ...grantsOf({ documents: [".github/PULL_REQUEST_TEMPLATE.md"], others: [] }),
        ]),
      ),
    ).toEqual([]);
    for (const grant of [
      {
        path: ".github",
        allow: [DIRECTORY, "writesToTheTerminal"],
        services: [],
        cannotImport: [],
      },
      { path: ".github", allow: [DIRECTORY], services: ["Store"], cannotImport: [] },
    ] satisfies Parameters<typeof permissionGrantViolations>[1]) {
      expect(
        taggedViolations(permissionGrantViolations([".github/actions/run.ts"], [grant])),
      ).toEqual([
        "oxlint.config.ts: error DirectoryGrantedPermissions: .github is a directory but is granted file permissions or services",
      ]);
    }
  }),
);

export const directoryGrantsRequireDirectories = Task.make(
  "directory grants accept actual directories and refuse files and missing paths",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["src/index.ts", ".env"],
          directoryGrantsOf(["src", "src/index.ts", ".env", ".missing"]),
        ),
      ),
    ).toEqual([
      ...["src/index.ts", ".env"].map(
        (path) =>
          `oxlint.config.ts: error DirectoryGrantOnFile: ${path} is granted isAnUnlistedDirectory, but is a file`,
      ),
      "oxlint.config.ts: error GrantedPathMissing: .missing is listed but is not a repository file or directory",
    ]);
  }),
);

export const standardDirectoriesNeedNoGrants = Task.make(
  "src, scripts and docs at the root and ordinary nested directories need no directory grants, while documents still need theirs",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          [
            "src/index.ts",
            "src/auth/login.ts",
            "src/auth/internal/token.ts",
            "scripts/ci.ts",
            "scripts/tests/fixtures/sample.json",
            "docs/guide.md",
          ],
          grantsOf({ documents: ["docs/guide.md"], others: [] }),
        ),
      ),
    ).toEqual([]);
  }),
);

export const nestedDirectoryGrantsDoNotGrantTheirParents = Task.make(
  "granting a nested ordinary directory does not permit an exceptional root, and nested packages still require their root directory's grant",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["vendor/library/data.json"],
          directoryGrantsOf(["vendor/library"]),
        ),
      ),
    ).toEqual([ungrantedDirectory("vendor")]);
    expect(
      taggedViolations(permissionGrantViolations([], [], ["packages/app", "packages/library"])),
    ).toEqual([ungrantedDirectory("packages")]);
    expect(
      taggedViolations(
        permissionGrantViolations([], directoryGrantsOf(["packages"]), [
          "packages/app",
          "packages/library",
        ]),
      ),
    ).toEqual([]);
  }),
);

export const scriptsNeedNoGrant = Task.make(
  "scripts directly in scripts/ run tasks by position, and helpers under scripts/shared need no grant either",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["scripts/ci.ts", "scripts/publish.ts", "scripts/shared/utils.ts", "tests/ci.ts"],
          [],
        ),
      ),
    ).toEqual([]);
  }),
);

export const grantsForMissingFilesAreRefused = Task.make(
  "a file granted permissions that is not a repository file is reported",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["scripts/ci.ts"],
          grantsOf({ documents: ["docs/gone.md"], others: ["scripts/bench.ts", "src/gone.ts"] }),
        ),
      ),
    ).toEqual([
      "oxlint.config.ts: error GrantedPathMissing: docs/gone.md is listed but is not a repository file or directory",
      "oxlint.config.ts: error GrantedPathMissing: scripts/bench.ts is listed but is not a repository file or directory",
      "oxlint.config.ts: error GrantedPathMissing: src/gone.ts is listed but is not a repository file or directory",
    ]);
  }),
);

export const grantsRepeatingBuiltInRulesAreRedundant = Task.make(
  "a grant that repeats a built-in rule is RedundantGrant: cannotImport of scripts or anything within it on src or a directory under it, while other cannotImport targets pass",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["src/web/index.ts", "src/cli/index.ts", "scripts/ci.ts"],
          [
            { path: "src", allow: [], services: [], cannotImport: ["scripts"] },
            {
              path: "src/web",
              allow: [],
              services: [],
              cannotImport: ["scripts/ci.ts", "src/cli"],
            },
          ],
        ),
      ),
    ).toEqual([
      'oxlint.config.ts: error RedundantGrant: src is granted cannotImport: ["scripts"], but files in src/ cannot import scripts/',
      'oxlint.config.ts: error RedundantGrant: src/web is granted cannotImport: ["scripts/ci.ts"], but files in src/ cannot import scripts/',
    ]);
  }),
);

export const grantedDocumentsPass = Task.make(
  "Markdown files granted hasAnUnlistedFileType pass wherever they live, and the root README.md passes without a grant",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["README.md", "docs/code-review.md", "packages/app/README.md"],
          [
            ...grantsOf({
              documents: ["docs/code-review.md", "packages/app/README.md"],
              others: [],
            }),
            ...directoryGrantsOf(["packages"]),
          ],
        ),
      ),
    ).toEqual([]);
  }),
);

export const rootReadmeGrantIsRedundant = Task.make(
  "a hasAnUnlistedFileType grant on the root README.md is RedundantGrant",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["README.md"],
          grantsOf({ documents: ["README.md"], others: [] }),
        ),
      ),
    ).toEqual([
      "oxlint.config.ts: error RedundantGrant: README.md is granted hasAnUnlistedFileType, but the root README.md needs no grant",
    ]);
  }),
);

export const ungrantedDocumentsAreRefused = Task.make(
  "a Markdown file without hasAnUnlistedFileType is reported",
  Effect.sync(() => {
    expect(
      taggedViolations(
        permissionGrantViolations(
          ["docs/code-review.md", "docs/permissions.md", "notes.markdown"],
          grantsOf({ documents: ["docs/code-review.md"], others: [] }),
        ),
      ),
    ).toEqual([
      "docs/permissions.md: error UngrantedDocument: is a document that oxlint.config.ts does not allow",
      "notes.markdown: error UngrantedDocument: is a document that oxlint.config.ts does not allow",
    ]);
  }),
);

const patchGrantsOf = (paths: readonly string[]) =>
  paths.map((path): Parameters<typeof patchGrantViolations>[1][number] => ({
    path,
    allow: [PATCH],
    services: [],
    cannotImport: [],
  }));

const notGranted = (dependency: string, patchPath: string) =>
  `package.json: error PatchNotGranted: patches ${dependency} with ${patchPath}, which oxlint.config.ts doesn't grant patchesADependency`;

const unlisted = (path: string) =>
  `oxlint.config.ts: error UnlistedPatchGranted: ${path} is granted patchesADependency, but package.json doesn't list it in patchedDependencies`;

export const ungrantedPatchesAreRefused = Task.make(
  "each dependency in patchedDependencies whose patch file oxlint.config.ts doesn't grant patchesADependency is PatchNotGranted, keyed by name and version or by name alone, and a grant path is matched literally rather than as a glob",
  Effect.sync(() => {
    expect(
      taggedViolations(
        patchGrantViolations(
          {
            patchedDependencies: {
              "effect@4.0.5": ".patches/effect@4.0.5.patch",
              "is-number": "./patches/is-number.patch",
            },
          },
          [
            ...grantsOf({ documents: ["README.md"], others: [".patches/effect@4.0.5.patch"] }),
            ...patchGrantsOf([".patches/effect@4.0.5.patch*"]),
          ],
        ),
      ),
    ).toEqual([
      notGranted("effect@4.0.5", ".patches/effect@4.0.5.patch"),
      notGranted("is-number", "patches/is-number.patch"),
      unlisted(".patches/effect@4.0.5.patch*"),
    ]);
  }),
);

export const grantedPatchesPass = Task.make(
  "patch files granted patchesADependency pass, a scoped package's %2F file name and a ./ prefix included, and a manifest without patchedDependencies needs no patch grant",
  Effect.sync(() => {
    expect(
      taggedViolations(
        patchGrantViolations(
          {
            patchedDependencies: {
              "effect@4.0.5": ".patches/effect@4.0.5.patch",
              "@effect/platform-node-shared@4.0.5":
                "./.patches/@effect%2Fplatform-node-shared@4.0.5.patch",
              "is-number": "patches/is-number.patch",
            },
          },
          patchGrantsOf([
            ".patches/effect@4.0.5.patch",
            ".patches/@effect%2Fplatform-node-shared@4.0.5.patch",
            "patches/is-number.patch",
          ]),
        ),
      ),
    ).toEqual([]);
    expect(
      taggedViolations(
        patchGrantViolations(
          { name: "unpatched" },
          grantsOf({ documents: ["README.md"], others: [] }),
        ),
      ),
    ).toEqual([]);
  }),
);

const checkOrTaskPatched = (dependency: string, patchPath: string) =>
  `package.json: error CheckOrTaskPatched: patches ${dependency} with ${patchPath}; patches to @sshkeda/check or @sshkeda/task are forbidden even when granted`;

export const checkAndTaskPatchesCannotBeGranted = Task.make(
  "patches to check or task are refused with or without grants, for bare names and any version spec, while similarly named packages keep normal grant behavior",
  Effect.sync(() => {
    const patchPath = ".patches/layout.patch";
    for (const name of ["@sshkeda/check", "@sshkeda/task"]) {
      for (const version of ["", "@0.34.1", "@^0.34.0", "@1.0.0-canary.1", "@*", "@latest"]) {
        const dependency = `${name}${version}`;
        for (const grants of [[], patchGrantsOf([patchPath])]) {
          expect(
            taggedViolations(
              patchGrantViolations({ patchedDependencies: { [dependency]: patchPath } }, grants),
            ),
          ).toEqual([checkOrTaskPatched(dependency, patchPath)]);
        }
      }
    }
    for (const dependency of [
      "@sshkeda/check-extra",
      "@sshkeda/task-extra@1.0.0",
      "@other/check",
      "check",
    ]) {
      const manifest = { patchedDependencies: { [dependency]: patchPath } };
      expect(taggedViolations(patchGrantViolations(manifest, []))).toEqual([
        notGranted(dependency, patchPath),
      ]);
      expect(patchGrantViolations(manifest, patchGrantsOf([patchPath]))).toEqual([]);
    }
  }),
);

export const patchGrantsOnUnlistedFilesAreRefused = Task.make(
  "a patch grant on a file patchedDependencies doesn't list is UnlistedPatchGranted, with or without patchedDependencies, and a patchedDependencies that isn't an object of paths is PatchedDependenciesMalformed",
  Effect.sync(() => {
    expect(
      taggedViolations(
        patchGrantViolations(
          { patchedDependencies: { "effect@4.0.5": ".patches/effect@4.0.5.patch" } },
          patchGrantsOf([
            ".patches/effect@4.0.5.patch",
            ".patches/effect@4.0.4.patch",
            "src/index.ts",
          ]),
        ),
      ),
    ).toEqual([unlisted(".patches/effect@4.0.4.patch"), unlisted("src/index.ts")]);
    expect(
      taggedViolations(patchGrantViolations({}, patchGrantsOf([".patches/effect@4.0.5.patch"]))),
    ).toEqual([unlisted(".patches/effect@4.0.5.patch")]);
    expect(
      taggedViolations(
        patchGrantViolations({ patchedDependencies: [".patches/effect@4.0.5.patch"] }, []),
      ),
    ).toEqual([
      "package.json: error PatchedDependenciesMalformed: has a patchedDependencies field that isn't an object of patch paths: Expected object",
    ]);
  }),
);

const layoutViolationsIn = (directory: string) =>
  findFileLayoutViolations(directory).pipe(
    Effect.as(new Array<string>()),
    Effect.catchTag("FileLayoutViolations", (failure) =>
      Effect.succeed(taggedViolations(failure.violations)),
    ),
  );

const repositoryWithConfig = (
  lintConfigBody: string | undefined,
  files: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    yield* linkNodeModulesWithCheck(directory);
    const lintConfig =
      lintConfigBody === undefined
        ? {}
        : {
            "oxlint.config.ts": `import { lintConfig } from "@sshkeda/check";\n${lintConfigBody}\n`,
          };
    for (const [file, text] of Object.entries({
      ".gitignore": "node_modules\n",
      "package.json": '{ "name": "laid-out" }\n',
      ...lintConfig,
      ...files,
    })) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(directory, file), text);
    }
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    return directory;
  });

export const dependenciesAreJudgedFromTheRealRepositoryRoot = Task.make(
  "a repository reached through a symlink judges package.json dependencies against its real root, so paths inside it pass and paths beside it are reported",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* repositoryWithConfig(undefined, {
      "package.json": yield* encodeJson({
        dependencies: { inside: "file:./vendor/x", sibling: "file:../sibling" },
      }),
    });
    const symlinked = path.join(yield* fileSystem.makeTempDirectoryScoped(), "symlinked");
    yield* fileSystem.symlink(directory, symlinked);
    expect(yield* layoutViolationsIn(symlinked)).toEqual([
      outside("dependencies.sibling", "file:../sibling"),
    ]);
  }).pipe(Effect.scoped),
);

export const directoriesOutsideAGitRepositoryFailLoudly = Task.make(
  "the layout check of a directory outside any git repository fails with RepositoryRootNotFound instead of judging dependencies against a guessed root",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{ "name": "a" }\n');
    const failure = yield* failureAsValue(findFileLayoutViolations(directory));
    expect(failure._tag).toBe("RepositoryRootNotFound");
  }).pipe(Effect.scoped),
);

export const rootGrantsMatchOnlyTheRootFile = Task.make(
  "a grant for a root file read back from the config covers that file and not a nested file of the same name",
  Effect.gen(function* () {
    const directory = yield* repositoryWithConfig(
      'export default lintConfig({ "notes.md": { allow: ["hasAnUnlistedFileType"] } });',
      {
        "notes.md": "# Notes\n",
        "docs/notes.md": "# Docs\n",
      },
    );
    expect(yield* layoutViolationsIn(directory)).toEqual([
      "docs/notes.md: error UngrantedDocument: is a document that oxlint.config.ts does not allow",
    ]);
  }).pipe(Effect.scoped),
);

export const patchesAreCheckedAgainstTheGrantsInTheConfig = Task.make(
  "the layout check reads patchedDependencies from the root package.json and the patch grants from oxlint.config.ts, and one patchesADependency grant on each patch file or on the directory bun patch writes them to lets bun's own file names, a scoped package's %2F included, pass with no directory grant, while a patch file the manifest doesn't list is still held to kebab-case",
  Effect.gen(function* () {
    const scopedPatch = "patches/@effect%2Fsql-sqlite-bun@4.1.0.patch";
    const manifest = yield* encodeJson({
      name: "patched",
      patchedDependencies: {
        "effect@4.1.0": "patches/effect@4.1.0.patch",
        "@effect/sql-sqlite-bun@4.1.0": scopedPatch,
      },
    });
    const files = {
      "package.json": manifest,
      "patches/effect@4.1.0.patch": "",
      [scopedPatch]: "",
    };
    const ungranted = yield* repositoryWithConfig("export default lintConfig({});", files);
    expect(yield* layoutViolationsIn(ungranted)).toEqual([
      ...[scopedPatch, "patches/effect@4.1.0.patch"].map(
        (path) => `${path}: error NotKebabCase: ${path.split("/").at(-1)} is not kebab-case`,
      ),
      ungrantedDirectory("patches"),
      notGranted("effect@4.1.0", "patches/effect@4.1.0.patch"),
      notGranted("@effect/sql-sqlite-bun@4.1.0", scopedPatch),
    ]);
    const eachFileGranted = yield* repositoryWithConfig(
      `export default lintConfig({
  "patches/effect@4.1.0.patch": { allow: ["patchesADependency"] },
  "${scopedPatch}": { allow: ["patchesADependency"] },
});`,
      files,
    );
    expect(yield* layoutViolationsIn(eachFileGranted)).toEqual([]);
    const directoryGranted = yield* repositoryWithConfig(
      'export default lintConfig({ patches: { allow: ["patchesADependency"] } });',
      { ...files, "patches/Unlisted.patch": "" },
    );
    expect(yield* layoutViolationsIn(directoryGranted)).toEqual([
      "patches/Unlisted.patch: error NotKebabCase: Unlisted.patch is not kebab-case",
    ]);
    const unlistedDirectory = yield* repositoryWithConfig(
      'export default lintConfig({ patches: { allow: ["patchesADependency"] } });',
      { "package.json": yield* encodeJson({ name: "unpatched" }), "patches/a.patch": "" },
    );
    expect(yield* layoutViolationsIn(unlistedDirectory)).toEqual([unlisted("patches")]);
  }).pipe(Effect.scoped),
);

export const onlyBunsOwnPatchFileNamesSkipKebabCase = Task.make(
  "a listed and granted patch file skips kebab-case only when its name is the one bun patch writes for its patchedDependencies key",
  Effect.gen(function* () {
    const grant = 'export default lintConfig({ patches: { allow: ["patchesADependency"] } });';
    for (const [dependency, patchPath] of [
      ["effect@4.1.0", "patches/NOT_A_BUN_FILENAME.patch"],
      ["effect@4.1.0", "patches/effect@4.0.5.patch"],
      ["@effect/sql-sqlite-bun@4.1.0", "patches/@effect@sql-sqlite-bun@4.1.0.patch"],
      ["@effect/sql-sqlite-bun@4.1.0", "patches/effect@4.1.0.patch"],
    ] as const) {
      const directory = yield* repositoryWithConfig(grant, {
        "package.json": yield* encodeJson({
          name: "patched",
          patchedDependencies: { [dependency]: patchPath },
        }),
        [patchPath]: "",
      });
      expect(yield* layoutViolationsIn(directory)).toEqual([
        `${patchPath}: error NotKebabCase: ${patchPath.split("/").at(-1)} is not kebab-case`,
      ]);
    }
    expect(
      [
        "is-odd@3.0.1",
        "@sindresorhus/is@7.0.0",
        "pkg@https://user:token@registry.example.com/pkg.tgz?signature=x#sha",
        "pkg@github:user/repo#a1b2",
      ].map((dependency) => bunPatchFileNameOf(dependency)),
    ).toEqual([
      "is-odd@3.0.1.patch",
      "@sindresorhus%2Fis@7.0.0.patch",
      "pkg@https%3A%2F%2Fregistry.example.com%2Fpkg.tgz#sha.patch",
      "pkg@github%3Auser%2Frepo#a1b2.patch",
    ]);
  }).pipe(Effect.scoped),
);

export const theLayoutCheckRefusesGrantedCheckAndTaskPatches = Task.make(
  "the layout check refuses manifest patches to check and task even when oxlint.config.ts grants their shared patch file",
  Effect.gen(function* () {
    const patchPath = ".patches/layout.patch";
    const dependencies = ["@sshkeda/check@0.34.1", "@sshkeda/task"];
    const manifest = yield* encodeJson({
      name: "patched",
      patchedDependencies: Object.fromEntries(
        dependencies.map((dependency) => [dependency, patchPath]),
      ),
    });
    const directory = yield* repositoryWithConfig(
      `export default lintConfig({ ".patches": { allow: ["isAnUnlistedDirectory"] }, "${patchPath}": { allow: ["patchesADependency"] } });`,
      { "package.json": manifest, [patchPath]: "" },
    );
    expect(yield* layoutViolationsIn(directory)).toEqual(
      dependencies.map((dependency) => checkOrTaskPatched(dependency, patchPath)),
    );
  }).pipe(Effect.scoped),
);

const configViolationsIn = (directory: string) =>
  Effect.gen(function* () {
    expect(yield* layoutViolationsIn(directory)).toEqual([]);
    return yield* loadedLintConfigIn(directory).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("LintConfigRefused", (refused) =>
        Effect.succeed(taggedViolations(refused.violations)),
      ),
    );
  });

export const configsOtherThanALiteralLintConfigCallAreReportedInsteadOfGrantedFiles = Task.make(
  "a config that extends, spreads or binds lintConfig() is refused by the config loader while layout blames no granted file, and a missing config is reported",
  Effect.gen(function* () {
    const files = { "scripts/ci.ts": RUNNABLE, "scripts/forged.ts": RUNNABLE };
    const extended = yield* repositoryWithConfig(
      'export default { extends: [lintConfig({ "scripts/ci.ts": { allow: ["writesToTheTerminal"] } })], overrides: [{ files: ["./scripts/forged.ts"], rules: {} }] };',
      files,
    );
    expect(yield* configViolationsIn(extended)).toEqual([
      "oxlint.config.ts:2: error ConfigFileExportsSomethingElse: exports something other than lintConfig({ ... })",
    ]);
    const spread = yield* repositoryWithConfig(
      'const granted = { "scripts/ci.ts": { allow: ["writesToTheTerminal"] } };\nexport default lintConfig({ ...granted });',
      files,
    );
    expect(yield* configViolationsIn(spread)).toEqual([
      'oxlint.config.ts:2: error ConfigFileHoldsOtherStatement: holds a statement other than import { lintConfig } from "@sshkeda/check" and export default lintConfig({ ... })',
      "oxlint.config.ts:3: error LintConfigArgumentNotLiteral: passes lintConfig() something other than literals",
    ]);
    const missing = yield* repositoryWithConfig(undefined, files);
    expect(yield* configViolationsIn(missing)).toEqual([
      "oxlint.config.ts: error ConfigFileMissing: does not exist",
    ]);
    const nothingGranted = yield* repositoryWithConfig("export default lintConfig({});", {
      "src/index.ts": "export const MAIN = 1;\n",
    });
    expect(yield* configViolationsIn(nothingGranted)).toEqual([]);
  }).pipe(Effect.scoped),
);

export const boundaryPathsAreVerifiedOnDisk = Task.make(
  "directory and file keys and cannotImport targets must exist, and ordinary directories cannot receive file permissions",
  Effect.gen(function* () {
    const directory = yield* repositoryWithConfig(
      `export default lintConfig({
  src: { cannotImport: ["src/gone", "lib/gone.ts"] },
  "src/index.ts": { cannotImport: ["src/lib/store/index.ts"] },
  "src/lib/store": { allow: ["usesSqlDatabases"] },
  "src/lib/worker": { cannotImport: ["src/lib/store"] },
});`,
      {
        "src/index.ts": "export const MAIN = 1;\n",
        "src/lib/store/index.ts": "export const SQL = 1;\n",
        "scripts/ci.ts": RUNNABLE,
        "scripts/shared/helper.ts": "export const HELPER = 1;\n",
      },
    );
    expect(yield* layoutViolationsIn(directory)).toEqual([
      "oxlint.config.ts: error CannotImportTargetMissing: src/gone is in cannotImport of src but is not a repository file or directory",
      "oxlint.config.ts: error CannotImportTargetMissing: lib/gone.ts is in cannotImport of src but is not a repository file or directory",
      "oxlint.config.ts: error DirectoryGrantedPermissions: src/lib/store is a directory but is granted file permissions or services",
      "oxlint.config.ts: error GrantedPathMissing: src/lib/worker is listed but is not a repository file or directory",
    ]);
  }).pipe(Effect.scoped),
);

export const bunTestNamesAreRefusedEverywhere = Task.make(
  "*.test.ts and *.spec.ts names are refused everywhere, tests/ included",
  Effect.sync(() => {
    for (const testPath of [
      "src/cache/cache.test.ts",
      "src/cache/cache.spec.ts",
      "tests/cache.test.ts",
      "tests/fixtures/sample.spec.ts",
    ]) {
      expect(taggedViolations(pathViolations(testPath))).toEqual([
        `${testPath}: error BunTestFileName: is named like a bun test`,
      ]);
    }
  }),
);

export const packageScriptsAreBanned = Task.make(
  "package.json files with a scripts field are reported",
  Effect.gen(function* () {
    expect(
      taggedViolations(
        yield* manifestViolations("package.json", '{ "name": "a" }', AT_REPOSITORY_ROOT),
      ),
    ).toEqual([]);
    expect(
      taggedViolations(
        yield* manifestViolations(
          "packages/a/package.json",
          '{ "scripts": { "test": "bun test" } }',
          AT_REPOSITORY_ROOT,
        ),
      ),
    ).toEqual(['packages/a/package.json: error PackageScriptsField: has a "scripts" field']);
  }),
);

export const dependenciesOutsideTheRepositoryAreReported = Task.make(
  "file:, link:, bare relative and absolute dependencies that resolve outside the repository are reported in every dependency field and in overrides, while paths inside the repository and workspace: specifiers pass",
  Effect.gen(function* () {
    const repository = { root: "/repository", packageDirectory: "/repository/packages/app" };
    const manifest = yield* encodeJson({
      dependencies: {
        inside: "file:../library",
        "inside-bare": "./vendor/x",
        workspace: "workspace:*",
        published: "1.2.3",
        outside: "file:../../../check-dev",
      },
      devDependencies: { "@sshkeda/check": "link:../../../check-dev" },
      peerDependencies: { peer: "link:../../../peer" },
      optionalDependencies: { bare: "../../../bare", absolute: "/tmp/check.tgz" },
      overrides: {
        "@sshkeda/task": "file:../../../task-dev",
        nested: { deep: "file:../../../.." },
      },
    });
    expect(
      taggedViolations(yield* manifestViolations("package.json", manifest, repository)),
    ).toEqual([
      outside("dependencies.outside", "file:../../../check-dev"),
      outside("devDependencies.@sshkeda/check", "link:../../../check-dev"),
      outside("peerDependencies.peer", "link:../../../peer"),
      outside("optionalDependencies.bare", "../../../bare"),
      outside("optionalDependencies.absolute", "/tmp/check.tgz"),
      outside("overrides.@sshkeda/task", "file:../../../task-dev"),
      outside("overrides.nested.deep", "file:../../../.."),
    ]);
  }),
);

export const rootDependenciesOnSiblingCheckoutsAreReported = Task.make(
  "a root package.json that depends on a sibling checkout through devDependencies and overrides is reported for each",
  Effect.gen(function* () {
    const manifest = yield* encodeJson({
      devDependencies: { "@sshkeda/check": "file:../check-dev", inside: "file:./packages/x" },
      overrides: { "@sshkeda/check": "file:../check-dev" },
    });
    expect(
      taggedViolations(yield* manifestViolations("package.json", manifest, AT_REPOSITORY_ROOT)),
    ).toEqual([
      outside("devDependencies.@sshkeda/check", "file:../check-dev"),
      outside("overrides.@sshkeda/check", "file:../check-dev"),
    ]);
  }),
);

export const symlinksLeavingTheRepositoryAreOutOfScopeForTheLexicalCheck = Task.make(
  "dependency paths are judged lexically without following symlinks, so a symlink inside the repository that points outside it passes and is out of scope for this rule",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.makeDirectory(path.join(root, "vendor"));
      yield* fileSystem.symlink(outsideDirectory, path.join(root, "vendor/escape"));
      const manifest = yield* encodeJson({ dependencies: { escape: "file:./vendor/escape" } });
      expect(
        taggedViolations(
          yield* manifestViolations("package.json", manifest, { root, packageDirectory: root }),
        ),
      ).toEqual([]);
    }),
  ),
);

export const subdirectoryManifestPathsResolveFromTheirOwnDirectory = Task.make(
  "a package.json in a subdirectory resolves its dependency paths from that subdirectory, so ../../../sibling leaves the repository and ../library does not",
  Effect.gen(function* () {
    const manifest = yield* encodeJson({
      dependencies: { library: "file:../library", sibling: "file:../../../sibling" },
    });
    expect(
      taggedViolations(
        yield* manifestViolations("packages/app/package.json", manifest, AT_REPOSITORY_ROOT),
      ),
    ).toEqual([
      outside("dependencies.sibling", "file:../../../sibling", "packages/app/package.json"),
    ]);
  }),
);

export const encodedAndBackslashPathsAreReadAsBunReadsThem = Task.make(
  "percent-encoded file: paths stay encoded because bun install does not decode them, and backslashes are ordinary characters because paths are posix-only",
  Effect.gen(function* () {
    const manifest = yield* encodeJson({
      dependencies: { encoded: "file:%2e%2e/x", backslashed: "file:..\\x" },
    });
    expect(
      taggedViolations(yield* manifestViolations("package.json", manifest, AT_REPOSITORY_ROOT)),
    ).toEqual([]);
  }),
);

export const manifestParseFailuresAreToldApartFromWrongShapes = Task.make(
  "a package.json that does not parse is reported as such, while valid JSON that is not an object is reported as not holding an object",
  Effect.gen(function* () {
    expect(
      taggedViolations(yield* manifestViolations("package.json", "{", AT_REPOSITORY_ROOT)),
    ).toEqual([
      "package.json: error PackageManifestUnparsable: is not valid JSON: Expected a valid JSON string",
    ]);
    for (const text of ["[]", "null", "1"]) {
      expect(
        taggedViolations(yield* manifestViolations("package.json", text, AT_REPOSITORY_ROOT)),
      ).toEqual([
        "package.json: error PackageManifestNotObject: does not hold a JSON object: Expected object",
      ]);
    }
  }),
);

export const layoutCheckListsGitFiles = Task.make(
  "the layout check reads tracked and untracked files from git, skips ignored ones and reads permission grants from oxlint.config.ts",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const write = (file: string, text: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(path.join(directory, file)), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(path.join(directory, file), text);
        });
      yield* linkNodeModulesWithCheck(directory);
      const grantPermissions = (permissionsByFile: string) =>
        write(
          "oxlint.config.ts",
          `import { lintConfig } from "@sshkeda/check";\nexport default lintConfig(${permissionsByFile});\n`,
        );
      const grantedFiles =
        '"scripts/release.ts": { allow: ["writesToTheTerminal"] }, "docs/code-review.md": { allow: ["hasAnUnlistedFileType"] }';
      yield* grantPermissions(`{ ${grantedFiles} }`);
      yield* write(".gitignore", "ignored\nnode_modules\n");
      yield* write("package.json", '{ "name": "a" }\n');
      yield* write("scripts/ci.ts", RUNNABLE);
      yield* write("scripts/release.ts", RUNNABLE);
      yield* write("ignored/NOTES.md", "ignored\n");
      yield* write("docs/code-review.md", "# Code Review\n");
      yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
      expect(yield* loadedLintConfigIn(directory)).toEqual([
        {
          path: "scripts/release.ts",
          allow: ["writesToTheTerminal"],
          services: [],
          cannotImport: [],
        },
        {
          path: "docs/code-review.md",
          allow: ["hasAnUnlistedFileType"],
          services: [],
          cannotImport: [],
        },
      ]);
      yield* findFileLayoutViolations(directory);
      yield* write("NOTES.md", "notes\n");
      yield* write("scripts/setup.ts", "export const setup = 1;\n");
      const found = yield* findFileLayoutViolations(directory).pipe(
        Effect.as(new Array<string>()),
        Effect.catchTag("FileLayoutViolations", (failure) =>
          Effect.succeed(taggedViolations(failure.violations)),
        ),
      );
      expect(found).toEqual([
        "NOTES.md: error NotKebabCase: NOTES.md is not kebab-case",
        withoutMain("scripts/setup.ts"),
        "NOTES.md: error UngrantedDocument: is a document that oxlint.config.ts does not allow",
      ]);
      yield* fileSystem.remove(path.join(directory, "scripts/release.ts"));
      yield* grantPermissions(
        `{ ${grantedFiles}, "ignored/NOTES.md": { allow: ["hasAnUnlistedFileType"] } }`,
      );
      const stale = yield* findFileLayoutViolations(directory).pipe(
        Effect.as(new Array<string>()),
        Effect.catchTag("FileLayoutViolations", (failure) =>
          Effect.succeed(taggedViolations(failure.violations)),
        ),
      );
      expect(stale).toContain(
        "oxlint.config.ts: error GrantedPathMissing: scripts/release.ts is listed but is not a repository file or directory",
      );
      expect(stale).toContain(
        "oxlint.config.ts: error GrantedPathMissing: ignored/NOTES.md is listed but is not a repository file or directory",
      );
    }),
  ),
);

export const ignoredFilesDoNotKeepADirectoryFromHoldingOnlyADirectory = Task.make(
  "ignored files are not part of the layout, so a directory whose other entries are all ignored still holds only its directory",
  Effect.gen(function* () {
    const directory = yield* repositoryWithConfig(undefined, {
      ".gitignore": "node_modules\n*.log\n",
      "package.json": '{ "name": "a" }\n',
      "src/build.log": "built\n",
      "src/lib/memo/index.ts": "export const MAIN = 1;\n",
    });
    expect(yield* layoutViolationsIn(directory)).toEqual([holdsOnly("src", "lib")]);
  }).pipe(Effect.scoped),
);

export const aNestedPackageKeepsItsParentFromHoldingOnlyADirectory = Task.make(
  "a nested package left out of the layout still counts as an entry, so src/shared/fixtures/ holding the package pkg/ and data/ passes",
  Effect.gen(function* () {
    const directory = yield* repositoryWithConfig(undefined, {
      "package.json": '{ "name": "a" }\n',
      "src/index.ts": "export const MAIN = 1;\n",
      "src/shared/load-fixtures.ts": "export const FIXTURES = 1;\n",
      "src/shared/fixtures/data/a.json": "{}\n",
      "src/shared/fixtures/pkg/package.json": '{ "name": "pkg" }\n',
      "src/shared/fixtures/pkg/index.ts": "export const MAIN = 1;\n",
    });
    expect(yield* layoutViolationsIn(directory)).toEqual([]);
  }).pipe(Effect.scoped),
);

export const toolOwnedDotFilesPass = Task.make(
  "tool-owned files such as .vscode/settings.json and .claude/settings.json pass only with exact directory grants",
  Effect.gen(function* () {
    const directory = yield* repositoryWithConfig(
      'export default lintConfig({ ".vscode": { allow: ["isAnUnlistedDirectory"] }, ".claude": { allow: ["isAnUnlistedDirectory"] } });',
      {
        ".vscode/settings.json": "{}\n",
        ".claude/settings.json": "{}\n",
        "src/index.ts": "export const MAIN = 1;\n",
      },
    );
    expect(yield* layoutViolationsIn(directory)).toEqual([]);
  }).pipe(Effect.scoped),
);

export const layoutRequiresGrantsForExceptionalDirectories = Task.make(
  "directory grants allow exceptional paths but do not exempt hidden files from naming or directory shape rules",
  Effect.gen(function* () {
    const files = {
      ".github/workflows/CI.yml": "name: ci\n",
      ".claude/settings.json": "{}\n",
      ".local-packages/check.tgz": "archive fixture\n",
      "vendor/acme.json": "{}\n",
      "src/index.ts": "export const MAIN = 1;\n",
    };
    const ungranted = yield* repositoryWithConfig("export default lintConfig({});", files);
    const layoutErrors = [
      ".github/workflows/CI.yml: error NotKebabCase: CI.yml is not kebab-case",
      holdsOnly(".github", "workflows"),
    ];
    expect(yield* layoutViolationsIn(ungranted)).toEqual([
      ...layoutErrors,
      ...[".claude", ".github", ".local-packages", "vendor"].map((directory) =>
        ungrantedDirectory(directory),
      ),
    ]);
    const granted = yield* repositoryWithConfig(
      'export default lintConfig({ ".github": { allow: ["isAnUnlistedDirectory"] }, ".claude": { allow: ["isAnUnlistedDirectory"] }, ".local-packages": { allow: ["isAnUnlistedDirectory"] }, vendor: { allow: ["isAnUnlistedDirectory"] } });',
      files,
    );
    expect(yield* layoutViolationsIn(granted)).toEqual(layoutErrors);
  }).pipe(Effect.scoped),
);

export const nestedPackagesDoNotHideDotDirectories = Task.make(
  "nested packages leave their parent root directories visible and do not require grants for nested directories",
  Effect.gen(function* () {
    for (const parent of [".local-packages", "vendor"]) {
      const files = {
        "src/index.ts": "export const MAIN = 1;\n",
        [`${parent}/.library/package.json`]: '{ "name": "library" }\n',
        [`${parent}/.library/index.ts`]: "export const LIBRARY = 1;\n",
      };
      const ungranted = yield* repositoryWithConfig("export default lintConfig({});", files);
      expect(yield* layoutViolationsIn(ungranted)).toEqual([
        holdsOnly(parent, ".library"),
        ungrantedDirectory(parent),
      ]);
      const granted = yield* repositoryWithConfig(
        `export default lintConfig({ "${parent}": { allow: ["isAnUnlistedDirectory"] } });`,
        files,
      );
      expect(yield* layoutViolationsIn(granted)).toEqual([holdsOnly(parent, ".library")]);
    }
  }).pipe(Effect.scoped),
);

export const ignoredDotDirectoriesStayOutsideTheLayout = Task.make(
  "ignored dot-directories need no grants, while a dot-directory whose name ends in .md can be granted as a directory",
  Effect.gen(function* () {
    const directory = yield* repositoryWithConfig(
      'export default lintConfig({ ".tool.md": { allow: ["isAnUnlistedDirectory"] } });',
      {
        ".gitignore": "node_modules\n.cache/\n",
        ".cache/result.json": "{}\n",
        ".tool.md/config.json": "{}\n",
        "src/index.ts": "export const MAIN = 1;\n",
      },
    );
    expect(yield* layoutViolationsIn(directory)).toEqual([]);
  }).pipe(Effect.scoped),
);

export const documentsDirectoryHoldsOnlyMarkdown = Task.make(
  "a non-markdown file in docs is MisplacedAtPackageRoot while directory placement belongs to the grant check",
  Effect.sync(() => {
    expect(
      taggedViolations(
        packageRootViolations([
          "package.json",
          "README.md",
          "bunfig.toml",
          "oxlint.config.ts",
          "vite.config.mts",
          ".prettierrc.ts",
          "globals.d.ts",
          "route-worker.ts",
          "src/index.ts",
          "scripts/ci.ts",
          "docs/guide.md",
          "docs/example.ts",
          ".github/workflows/ci.yml",
          ".claude/hooks/lint.ts",
          "apps/cli/index.ts",
          "apps/web/index.ts",
          "packages/protocol/index.ts",
          "shared/entry.ts",
          "hooks/lint.ts",
          "lib/util.ts",
        ]),
      ),
    ).toEqual(["docs/example.ts: error MisplacedAtPackageRoot: is not markdown but sits in docs/"]);
  }),
);

export const sourceImplementationsBelongInInternalOrShared = Task.make(
  "source and test surfaces are index.ts or index.tsx, while named implementations belong in internal/ or shared/",
  Effect.sync(() => {
    for (const path of [
      "src/parser.ts",
      "src/parser/parse.ts",
      "src/view/component.tsx",
      "src/internal-tools/tool.ts",
      "src/shared-tools/tool.ts",
      "src/index.js",
      "src/parser.mts",
      "tests/parser.ts",
      "tests/fixtures/parser.ts",
    ]) {
      expect(taggedViolations(sourceViolations(path, "export const VALUE = 1;"))).toEqual([
        outsideImplementation(path),
      ]);
    }
    for (const path of [
      "src/index.ts",
      "src/parser/index.ts",
      "src/view/index.tsx",
      "src/internal/parser.ts",
      "src/shared/parser.ts",
      "src/parser/internal/parse.ts",
      "src/parser/shared/parse.ts",
      "src/environment.d.ts",
      "src/view/types.d.mts",
      "scripts/shared/parser.ts",
      "tests/index.ts",
      "tests/internal/parser.ts",
      "tests/shared/parser.ts",
    ]) {
      expect(taggedViolations(sourceViolations(path, RUNNABLE))).toEqual([]);
    }
  }),
);

export const sourcePlacementUsesExistingFileScopeAndGrants = Task.make(
  "source placement keeps assets, generated files, ignored files and nested packages outside its scope",
  Effect.gen(function* () {
    const directory = yield* repositoryWithConfig(
      'export default lintConfig({ "src/generated.ts": { allow: [{ isGeneratedByATool: "written by a code generator" }] } });',
      {
        ".gitignore": "node_modules\nsrc/ignored.ts\n",
        "src/index.ts": "export const MAIN = 1;\n",
        "src/parser.ts": "export const PARSER = 1;\n",
        "src/generated.ts": "export const GENERATED = 1;\n",
        "src/ignored.ts": "export const IGNORED = 1;\n",
        "src/logo.svg": "<svg/>\n",
        "src/environment.d.ts": "export {};\n",
        "src/nested/package.json": '{ "name": "nested" }\n',
        "src/nested/parser.ts": "export const PARSER = 1;\n",
      },
    );
    expect(yield* layoutViolationsIn(directory)).toEqual([outsideImplementation("src/parser.ts")]);
  }).pipe(Effect.scoped),
);

export const rootCodeBelongsInScriptsOrSource = Task.make(
  "a root code file other than a named supported tool file is MisplacedAtPackageRoot, stated as a task script when it calls Task.main and as code otherwise",
  Effect.sync(() => {
    expect(
      taggedViolations([
        ...sourceViolations("deploy.ts", RUNNABLE),
        ...sourceViolations("route-worker.ts", "export const ROUTE = 1;\n"),
        ...sourceViolations("vite.config.mts", "export default {};\n"),
        ...sourceViolations(".prettierrc.ts", "export default {};\n"),
        ...sourceViolations("globals.d.ts", "export {};\n"),
        ...sourceViolations("bun-env.d.ts", "export {};\n"),
        ...sourceViolations(".eslintrc.cjs", "module.exports = {};\n"),
      ]),
    ).toEqual([
      "deploy.ts: error MisplacedAtPackageRoot: is a task script at the package root",
      "route-worker.ts: error MisplacedAtPackageRoot: is code at the package root",
      "vite.config.mts: error MisplacedAtPackageRoot: is code at the package root",
      ".prettierrc.ts: error MisplacedAtPackageRoot: is code at the package root",
      "globals.d.ts: error MisplacedAtPackageRoot: is code at the package root",
      "bun-env.d.ts: error MisplacedAtPackageRoot: is code at the package root",
      ".eslintrc.cjs: error MisplacedAtPackageRoot: is code at the package root",
    ]);
  }),
);

const exportViolationsOf = (exports: Schema.Json) =>
  Effect.gen(function* () {
    const manifest = yield* encodeJson({ name: "a", exports });
    return taggedViolations(
      yield* manifestViolations("package.json", manifest, AT_REPOSITORY_ROOT),
    );
  });

const mismatch = (field: string, target: string, index: string) =>
  `package.json: error ExportPathMismatch: ${field} points to ${target}, which is not ${index}`;

export const exportsPointingAtTheIndexOfTheDirectoryTheyNamePass = Task.make(
  "each exports subpath ./X pointing at lib/X/index in its source or build directory, and ./X/Y at lib/X/lib/Y/index, passes under every condition, as does . pointing at the root index, while non-code targets and null exclusions are not judged",
  Effect.gen(function* () {
    const passing = [
      {
        "./dispatcher": "./src/lib/dispatcher/index.ts",
        "./runtime": "./src/lib/runtime/index.ts",
        "./minecraft": "./src/lib/minecraft/index.ts",
        "./monitor": "./src/lib/monitor/index.ts",
      },
      {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./tasks": {
          types: "./dist/lib/tasks/index.d.ts",
          bun: "./src/lib/tasks/index.ts",
          default: "./dist/lib/tasks/index.js",
        },
      },
      {
        ".": {
          "@sshkeda/task-source": "./src/index.ts",
          types: "./dist/index.d.ts",
          default: "./src/index.ts",
        },
      },
      {
        "./a/b": {
          import: {
            types: "./dist/lib/a/lib/b/index.d.mts",
            default: "./dist/lib/a/lib/b/index.mjs",
          },
        },
        "./view": ["./src/lib/view/index.tsx", "./dist/lib/view/index.cjs"],
        "./package.json": "./package.json",
        "./styles": "./src/styles/theme.css",
        "./hidden": null,
      },
      "./dist/index.js",
      { types: "./dist/index.d.ts", default: "./src/index.ts" },
    ];
    for (const exports of passing) {
      expect(yield* exportViolationsOf(exports)).toEqual([]);
    }
  }),
);

export const exportsPointingAnywhereButTheIndexOfTheDirectoryTheyNameAreReported = Task.make(
  "an exports target that is not the index of the module in lib/ its subpath names is reported under each condition, including a directory outside lib/, a renamed directory, a non-index file, a nested subpath pointing a level off and a target with no source or build directory",
  Effect.gen(function* () {
    expect(
      yield* exportViolationsOf({
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./tasks": {
          types: "./dist/lib/everything-the-check-task-runs/index.d.ts",
          bun: "./src/lib/everything-the-check-task-runs/index.ts",
          default: "./dist/lib/everything-the-check-task-runs/index.js",
        },
      }),
    ).toEqual([
      mismatch(
        'exports["./tasks"].types',
        "./dist/lib/everything-the-check-task-runs/index.d.ts",
        "lib/tasks/index",
      ),
      mismatch(
        'exports["./tasks"].bun',
        "./src/lib/everything-the-check-task-runs/index.ts",
        "lib/tasks/index",
      ),
      mismatch(
        'exports["./tasks"].default',
        "./dist/lib/everything-the-check-task-runs/index.js",
        "lib/tasks/index",
      ),
    ]);
    expect(
      yield* exportViolationsOf({
        ".": { "@sshkeda/task-source": "./src/index.ts", default: "./src/index.ts" },
        "./errors": {
          "@sshkeda/task-source": "./src/lib/errors/errors.ts",
          types: "./dist/lib/errors/errors.d.ts",
          default: "./src/lib/errors/errors.ts",
        },
      }),
    ).toEqual([
      mismatch(
        'exports["./errors"]["@sshkeda/task-source"]',
        "./src/lib/errors/errors.ts",
        "lib/errors/index",
      ),
      mismatch('exports["./errors"].types', "./dist/lib/errors/errors.d.ts", "lib/errors/index"),
      mismatch('exports["./errors"].default', "./src/lib/errors/errors.ts", "lib/errors/index"),
    ]);
    expect(
      yield* exportViolationsOf({
        ".": "./src/main.ts",
        "./a/b": "./src/b/index.ts",
        "./a": "./src/a/b/index.ts",
        "./c": "./c/index.ts",
        "./d": ["./src/lib/d/index.ts", "./src/d.ts"],
        "./g": "./src/g/index.ts",
      }),
    ).toEqual([
      mismatch('exports["."]', "./src/main.ts", "the root index"),
      mismatch('exports["./a/b"]', "./src/b/index.ts", "lib/a/lib/b/index"),
      mismatch('exports["./a"]', "./src/a/b/index.ts", "lib/a/index"),
      mismatch('exports["./c"]', "./c/index.ts", "lib/c/index"),
      mismatch('exports["./d"][1]', "./src/d.ts", "lib/d/index"),
      mismatch('exports["./g"]', "./src/g/index.ts", "lib/g/index"),
    ]);
    expect(
      yield* exportViolationsOf({
        "./a": "../a/index.ts",
        "./b": "/b/index.ts",
        "./c": "././c/index.ts",
        "./d": "./dist/wrong.js?version=1",
        "./e": "./dist/wrong.js#e",
        "./f": "./dist/lib/f/index.js?version=1",
      }),
    ).toEqual([
      mismatch('exports["./a"]', "../a/index.ts", "lib/a/index"),
      mismatch('exports["./b"]', "/b/index.ts", "lib/b/index"),
      mismatch('exports["./c"]', "././c/index.ts", "lib/c/index"),
      mismatch('exports["./d"]', "./dist/wrong.js?version=1", "lib/d/index"),
      mismatch('exports["./e"]', "./dist/wrong.js#e", "lib/e/index"),
    ]);
    expect(yield* exportViolationsOf("./index.js")).toEqual([
      mismatch("exports", "./index.js", "the root index"),
    ]);
    expect(yield* exportViolationsOf({ default: "./dist/cli.js" })).toEqual([
      mismatch("exports.default", "./dist/cli.js", "the root index"),
    ]);
  }),
);

export const taskNamespaceCallsHaveTheSameLayout = Task.make(
  "named Task imports and aliases run scripts and identify root task scripts",
  Effect.sync(() => {
    for (const name of ["Task", "T"]) {
      const runnable = guarded(
        `import { Task as ${name} } from "@sshkeda/task";\nimport { build } from "./shared/build.ts";`,
        `${name}.main(build)`,
      );
      expect(taggedViolations(sourceViolations("scripts/build.ts", runnable))).toEqual([]);
      expect(taggedViolations(sourceViolations("build.ts", runnable))).toEqual([
        "build.ts: error MisplacedAtPackageRoot: is a task script at the package root",
      ]);
    }
  }),
);

export const taskBindingsThroughANestedPackageKeepTheirLayout = Task.make(
  "layout follows task bindings through a nested package's re-exports and rejects an unrelated run binding",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const packageName of ["task-consumer", "@sshkeda/task"]) {
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* linkNodeModulesWithCheck(directory);
      yield* writtenFiles(directory, {
        "package.json": `{"name":"${packageName}"}`,
        ".gitignore": "node_modules\n",
        "oxlint.config.ts":
          'import { lintConfig } from "@sshkeda/check"; export default lintConfig({ tools: { allow: ["isAnUnlistedDirectory"] } });',
        "tools/package.json": '{"name":"task-tools"}',
        "tools/index.ts": 'export { Task as T, Task as Tasks } from "./internal/task.ts";',
        "tools/internal/task.ts": 'import { Task } from "@sshkeda/task"; export { Task };',
        "scripts/ci.ts":
          'import { T } from "../tools/index.ts";\n\nif (import.meta.main) {\n  T.main(work);\n}\n',
        "scripts/unrelated.ts": 'import { run } from "../src/index.ts"; run(work);',
        "src/index.ts": "export const run = (work: unknown) => work; export const make = run;",
      });
      yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
      const found = yield* findFileLayoutViolations(directory).pipe(
        Effect.as(new Array<string>()),
        Effect.catchTag("FileLayoutViolations", (failure) =>
          Effect.succeed(taggedViolations(failure.violations)),
        ),
      );
      expect(found).toEqual([withoutMain("scripts/unrelated.ts")]);
    }
  }).pipe(Effect.scoped),
);

export const taskSelfImportsKeepTheirLayout = Task.make(
  "task recognizes its public self imports before its declaration output is built, without treating unrelated relative imports as task API",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    yield* linkNodeModulesWithCheck(directory);
    yield* writtenFiles(directory, {
      "package.json":
        '{"name":"@sshkeda/task","type":"module","exports":{"types":"./dist/index.d.ts","default":"./src/index.ts"}}',
      ".gitignore": "node_modules\n",
      "oxlint.config.ts":
        'import { lintConfig } from "@sshkeda/check"; export default lintConfig({});',
      "src/index.ts": 'export * as Task from "./lib/task/index.ts";',
      "src/lib/task/index.ts": 'export { make, main } from "./internal/task.ts";',
      "src/lib/task/internal/task.ts":
        "export const make = (name: string, work: unknown) => work; export const main = (work: unknown) => work;",
      "src/internal/unrelated.ts": "export const main = (work: unknown) => work;",
      "scripts/ci.ts":
        'import { Task } from "@sshkeda/task";\n\nif (import.meta.main) {\n  Task.main(work);\n}\n',
      "scripts/unrelated.ts": 'import { main } from "../src/internal/unrelated.ts"; main(work);',
    });
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    const found = yield* findFileLayoutViolations(directory).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("FileLayoutViolations", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
    expect(found).toEqual([withoutMain("scripts/unrelated.ts")]);
  }).pipe(Effect.scoped),
);
