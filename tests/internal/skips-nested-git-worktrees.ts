import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { listedPackageFiles } from "../../src/lib/tasks/shared/list-package-files.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  FORMAT_CONFIG_TEXT,
  linkNodeModulesWithCheck,
  RUNNER,
  TASKS,
  writtenFiles,
} from "../shared/checked-project.ts";
import { encodeIndentedJson } from "../shared/indented-json.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const COMMIT_ARGUMENTS = [
  "-c",
  "user.name=check",
  "-c",
  "user.email=check@example.com",
  "commit",
  "--quiet",
  "--message",
  "initial",
] as const;

const WORKTREE_DIRECTORY = ".claude/worktrees/one";

const PRINTED_VIOLATION = "src/Bad_Name.ts: error NotKebabCase: Bad_Name.ts is not kebab-case";

const toolFiles = Effect.gen(function* () {
  return {
    "oxlint.config.ts":
      'import { lintConfig } from "@sshkeda/check";\n\nexport default lintConfig({ "src/images.bin": { allow: ["hasAnUnlistedFileType"] } });\n',
    "oxfmt.config.ts": FORMAT_CONFIG_TEXT,
    "index.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\n\nTask.main(check);\n`,
  };
});

const committedProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  yield* linkNodeModulesWithCheck(root);
  yield* writtenFiles(root, {
    ...(yield* toolFiles),
    "package.json": `${yield* encodeIndentedJson({ name: "checked", type: "module", main: "./src/index.ts" })}\n`,
    "tsconfig.json": `${yield* encodeIndentedJson({
      compilerOptions: {
        strict: true,
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        types: ["bun"],
        ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      },
      include: ["src/**/*.ts"],
    })}\n`,
    ".gitignore": "node_modules\nindex.ts\noxlint.config.ts\noxfmt.config.ts\n",
    "src/index.ts": "export const ROOT = 1;\n",
  });
  yield* fileSystem.makeDirectory(path.join(root, "empty"));
  yield* fileSystem.symlink("../empty", path.join(root, "src/images.bin"));
  yield* fileSystem.symlink("../missing", path.join(root, "src/dangling.bin"));
  yield* Task.exec("git", ["init", "--quiet"], { cwd: root });
  yield* Task.exec("bun", ["fmt", "."], { cwd: root });
  yield* Task.exec("git", ["add", "--all"], { cwd: root });
  yield* Task.exec("git", [...COMMIT_ARGUMENTS], { cwd: root });
  const worktree = path.join(root, WORKTREE_DIRECTORY);
  yield* Task.exec("git", ["worktree", "add", "--quiet", "--detach", WORKTREE_DIRECTORY], {
    cwd: root,
  });
  yield* linkNodeModulesWithCheck(worktree);
  yield* writtenFiles(worktree, {
    ...(yield* toolFiles),
    "src/Bad_Name.ts": "export const BAD = 1;\n",
  });
  return { root, worktree, taskStateDirectory: yield* fileSystem.makeTempDirectoryScoped() };
});

const printedCheckAt = (directory: string, taskStateDirectory: string) =>
  runTaskFile("bun index.ts", { cwd: directory, taskStateDirectory }).pipe(
    Effect.catchTag("CommandFailed", (failure) =>
      Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
    ),
  );

export const nestedGitWorktreeIsNeitherAFileNorAPackage = Task.make(
  "check run from the root of a checkout that holds a git worktree of itself under .claude/worktrees neither lists that worktree as a file nor checks it as a nested package, so a violation only the worktree holds is not reported and the root passes",
  Effect.gen(function* () {
    const { root, taskStateDirectory } = yield* committedProject;
    const printed = yield* printedCheckAt(root, taskStateDirectory);
    expect(printed).not.toContain("worktrees");
    expect(printed).not.toContain("Bad_Name");
    expect(printed).not.toContain(" error ");
    expect(printed).toContain("passed: ");
  }).pipe(Effect.scoped),
);

export const trackedSymbolicLinksStayListedWhateverTheyPointAt = Task.make(
  "the listed files of a package drop a nested git worktree's directory but keep a tracked symbolic link that points at a directory, so a grant on it is accepted, and drop one whose target is gone",
  Effect.gen(function* () {
    const { root } = yield* committedProject;
    const { packageFiles, nestedPackageDirectories } = yield* listedPackageFiles(root, []);
    expect(packageFiles).toContain("src/images.bin");
    expect(packageFiles).not.toContain("src/dangling.bin");
    expect(packageFiles.some((file) => file.startsWith(".claude"))).toBe(false);
    expect(nestedPackageDirectories).toEqual([]);
  }).pipe(Effect.scoped),
);

export const gitWorktreeIsCheckedWhenCheckRunsInsideIt = Task.make(
  "check run from inside a git worktree checks that worktree as its own project and reports its violation with a path from the worktree",
  Effect.gen(function* () {
    const { worktree, taskStateDirectory } = yield* committedProject;
    const printed = yield* printedCheckAt(worktree, taskStateDirectory);
    expect(printed).toContain(PRINTED_VIOLATION);
  }).pipe(Effect.scoped),
);
