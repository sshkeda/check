import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { installedBinary } from "../../src/lib/tasks/shared/find-installed-package-binaries.ts";
import { listedPackageFiles } from "../../src/lib/tasks/shared/list-package-files.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { programFiles } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import {
  makeProject as makeProjectWith,
  FORMAT_CONFIG_TEXT,
  linkNodeModulesWithCheck,
  NO_PERMISSIONS,
  OWNER_WRITES_EVERYONE_READS,
  RUNNER,
  TASKS,
  writtenFiles,
} from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { encodeIndentedJson } from "../shared/indented-json.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const PACKAGE_COMPILER_OPTIONS = {
  strict: true,
  module: "Preserve",
  moduleResolution: "Bundler",
  noEmit: true,
  skipLibCheck: true,
  types: ["bun"],
  ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
} as const;

const workspacePackage = (directory: string, name: string, include: readonly string[]) =>
  Effect.gen(function* () {
    return {
      [`${directory}package.json`]: `${yield* encodeIndentedJson({ name, type: "module", main: "./src/index.ts" })}\n`,
      [`${directory}tsconfig.json`]: `${yield* encodeIndentedJson({ compilerOptions: PACKAGE_COMPILER_OPTIONS, include: [...include] })}\n`,
      [`${directory}oxlint.config.ts`]: `import { lintConfig } from "@sshkeda/check";\n\nexport default lintConfig({});\n`,
      [`${directory}oxfmt.config.ts`]: FORMAT_CONFIG_TEXT,
      [`${directory}index.ts`]: `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { check } from ${yield* encodeJson(TASKS)};\n\nTask.main(check);\n`,
    };
  });

const workspaceWithTwoPackages = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  yield* linkNodeModulesWithCheck(root);
  const rootPackage = yield* workspacePackage("", path.basename(root), ["src/index.ts"]);
  yield* writtenFiles(root, {
    ...rootPackage,
    "package.json": `${yield* encodeIndentedJson({ name: path.basename(root), type: "module", main: "./src/index.ts", workspaces: ["packages/*"] })}\n`,
    "oxlint.config.ts":
      'import { lintConfig } from "@sshkeda/check";\n\nexport default lintConfig({ packages: { allow: ["isAnUnlistedDirectory"] } });\n',
    ".gitignore": "node_modules\nindex.ts\noxlint.config.ts\noxfmt.config.ts\n",
    "src/index.ts": "export const ROOT = 1;\n",
    ...(yield* workspacePackage("packages/app/", "app", ["src/**/*.ts"])),
    "packages/app/src/index.ts":
      'import { ANSWER } from "library/src/answer.js";\n\nexport const ROUNDED = ANSWER.toFixed(1);\n',
    "packages/library/package.json": `${yield* encodeIndentedJson({ name: "library", type: "module", exports: { "./src/*": "./src/*" } })}\n`,
    "packages/library/src/answer.js": "export const ANSWER = 42;\n",
    "packages/library/src/answer.d.ts": "export declare const ANSWER: number;\n",
    "packages/library/src/lowercase-constant.ts": "export const lowercaseConstant = 1;\n",
  });
  yield* fileSystem.symlink(
    path.join(root, "packages/library"),
    path.join(root, "node_modules/library"),
  );
  yield* Task.exec("git", ["init", "--quiet"], { cwd: root });
  yield* Task.exec("bun", ["fmt", "."], {
    cwd: root,
  });
  return { root, taskStateDirectory: yield* fileSystem.makeTempDirectoryScoped() };
});

const runCheck = (
  workspace: { readonly root: string; readonly taskStateDirectory: string },
  taskFile: string,
) =>
  runTaskFile(`bun ${taskFile}`, {
    cwd: workspace.root,
    taskStateDirectory: workspace.taskStateDirectory,
  }).pipe(
    Effect.catchTag("CommandFailed", (failure) =>
      Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
    ),
  );

const workspaceWithNestedPackages = (extraFiles: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* linkNodeModulesWithCheck(root);
    yield* writtenFiles(root, {
      ...(yield* workspacePackage("", path.basename(root), ["src/index.ts"])),
      "package.json": `${yield* encodeIndentedJson({ name: path.basename(root), type: "module", main: "./src/index.ts", workspaces: ["packages/*"] })}\n`,
      "oxlint.config.ts":
        'import { lintConfig } from "@sshkeda/check";\n\nexport default lintConfig({ packages: { allow: ["isAnUnlistedDirectory"] } });\n',
      ".gitignore": "node_modules\nindex.ts\noxlint.config.ts\noxfmt.config.ts\n",
      "src/index.ts": "export const ROOT = 1;\n",
      ...(yield* workspacePackage("packages/app/", "app", ["src/**/*.ts"])),
      "packages/app/oxlint.config.ts":
        'import { lintConfig } from "@sshkeda/check";\n\nexport default lintConfig({ inner: { allow: ["isAnUnlistedDirectory"] } });\n',
      "packages/app/src/index.ts": "export const APP = 1;\n",
      ...(yield* workspacePackage("packages/app/inner/", "inner", ["src/**/*.ts"])),
      "packages/app/inner/oxlint.config.ts":
        'import { lintConfig } from "@sshkeda/check";\n\nexport default lintConfig({ "notes.md": { allow: ["hasAnUnlistedFileType"] } });\n',
      "packages/app/inner/notes.md": "# Notes\n",
      "packages/app/inner/src/index.ts": "export const INNER = 1;\n",
      "packages/app/inner/src/Bad_Name.ts": "export const BAD = 1;\n",
      "packages/app/inner/stray.ts": "export const STRAY = 1;\n",
      "packages/app/inner/src/native.cpp": "",
      ...(yield* workspacePackage("packages/library/", "library", ["src/**/*.ts"])),
      "packages/library/src/index.ts":
        'import { lowercaseConstant } from "./lowercase-constant.ts";\n\nexport const LIBRARY = lowercaseConstant;\n',
      "packages/library/src/lowercase-constant.ts": "export const lowercaseConstant = 1;\n",
      ...extraFiles,
    });
    yield* Task.exec("git", ["init", "--quiet"], { cwd: root });
    yield* Task.exec("bun", ["fmt", "."], { cwd: root });
    return { root, taskStateDirectory: yield* fileSystem.makeTempDirectoryScoped() };
  });

export const rootPackageChecksEachNestedPackageFromItsOwnRoot = Task.make(
  "check run by the workspace root's task file checks each nested package, at any depth, as its own package: its files are judged from its own root with its own config files, and each report names the file from the root",
  Effect.gen(function* () {
    const printed = yield* runCheck(yield* workspaceWithNestedPackages(), "index.ts");
    expect(printed).not.toContain("left out nested packages");
    expect(printed).toContain(
      "packages/app/inner/src/Bad_Name.ts: error NotKebabCase: Bad_Name.ts is not kebab-case",
    );
    expect(printed).toContain("packages/app/inner/stray.ts: error MisplacedAtPackageRoot");
    expect(printed).toContain("packages/app/inner/src/native.cpp: error FileTypeNotGranted");
    expect(printed).toContain("packages/library/src/lowercase-constant.ts:1:14: error");
    expect(printed).not.toContain("notes.md");
    expect(printed).not.toContain("MisplacedToolFile");
    expect(printed).not.toContain("UngrantedDirectory");
    expect(printed).not.toContain("packages/app/src/");
    expect(printed).not.toContain(" src/index.ts");
  }).pipe(Effect.scoped),
);

export const nestedPackageNeedsItsOwnConfigFiles = Task.make(
  "check run by the workspace root's task file reports each config file a nested package lacks at that package's root, instead of leaving the package unchecked",
  Effect.gen(function* () {
    const printed = yield* runCheck(
      yield* workspaceWithNestedPackages({
        "packages/bare/package.json": '{ "name": "bare", "type": "module" }\n',
        "packages/bare/src/index.ts": "export const BARE = 1;\n",
      }),
      "index.ts",
    );
    for (const missing of [
      "[lint-config] packages/bare/oxlint.config.ts: error ConfigFileMissing",
      "[bun-fmt] packages/bare/oxfmt.config.ts: error ConfigFileMissing",
      "[typescript-config] packages/bare/tsconfig.json: error TypeScriptProjectFileMissing",
    ]) {
      expect(printed).toContain(missing);
    }
  }).pipe(Effect.scoped),
);

export const referencedProjectOutsideThePackageIsNamedFromTheRoot = Task.make(
  "check run by the workspace root's task file names a tsconfig that a nested package references outside itself by its path from the root",
  Effect.gen(function* () {
    const printed = yield* runCheck(
      yield* workspaceWithNestedPackages({
        "packages/app/tsconfig.json": `${yield* encodeIndentedJson({ compilerOptions: PACKAGE_COMPILER_OPTIONS, include: ["src/**/*.ts"], references: [{ path: "../library" }] })}\n`,
        "packages/library/tsconfig.json": `${yield* encodeIndentedJson({ compilerOptions: { ...PACKAGE_COMPILER_OPTIONS, strictNullChecks: false }, include: ["src/**/*.ts"] })}\n`,
      }),
      "index.ts",
    );
    expect(printed).toContain(
      "[typescript-config] packages/library/tsconfig.json: error LooseCompilerOption: strictNullChecks",
    );
    expect(printed).not.toContain("packages/app/packages/library");
  }).pipe(Effect.scoped),
);

export const referencedProjectInsideThePackageIsNamedFromTheRoot = Task.make(
  "check run by the workspace root's task file names a tsconfig that a nested package references inside itself by its path from the root, even when that path repeats the package's directory",
  Effect.gen(function* () {
    const printed = yield* runCheck(
      yield* workspaceWithNestedPackages({
        "packages/library/tsconfig.json": `${yield* encodeIndentedJson({ compilerOptions: PACKAGE_COMPILER_OPTIONS, include: ["src/**/*.ts"], references: [{ path: "./packages/library" }] })}\n`,
        "packages/library/packages/library/tsconfig.json": `${yield* encodeIndentedJson({ compilerOptions: { ...PACKAGE_COMPILER_OPTIONS, strictNullChecks: false }, include: ["src/**/*.ts"] })}\n`,
        "packages/library/packages/library/src/index.ts": "export const NESTED = 1;\n",
      }),
      "index.ts",
    );
    expect(printed).toContain(
      "[typescript-config] packages/library/packages/library/tsconfig.json: error LooseCompilerOption: strictNullChecks",
    );
    expect(printed).not.toContain(
      "[typescript-config] packages/library/tsconfig.json: error LooseCompilerOption: strictNullChecks",
    );
  }).pipe(Effect.scoped),
);

export const projectCheckedByTwoPackagesIsReportedOnce = Task.make(
  "check run by the workspace root's task file reports a tsconfig problem once when the root references a nested package that is also checked on its own",
  Effect.gen(function* () {
    const printed = yield* runCheck(
      yield* workspaceWithNestedPackages({
        "tsconfig.json": `${yield* encodeIndentedJson({ compilerOptions: PACKAGE_COMPILER_OPTIONS, include: ["src/index.ts"], references: [{ path: "./packages/library" }] })}\n`,
        "packages/library/tsconfig.json": `${yield* encodeIndentedJson({ compilerOptions: { ...PACKAGE_COMPILER_OPTIONS, strictNullChecks: false }, include: ["src/**/*.ts"] })}\n`,
      }),
      "index.ts",
    );
    expect(
      printed
        .split("\n")
        .filter((line) =>
          line.startsWith(
            "[typescript-config] packages/library/tsconfig.json: error LooseCompilerOption: strictNullChecks",
          ),
        ),
    ).toHaveLength(1);
  }).pipe(Effect.scoped),
);

export const packageCheckReportsPathsFromItsDirectory = Task.make(
  "check run by a workspace package's task file reports paths from that package and reruns when a declaration file of an imported sibling package changes",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* workspaceWithTwoPackages;
    expect(yield* runCheck(workspace, "packages/app/index.ts")).toContain("passed: ");
    yield* fileSystem.writeFileString(
      path.join(workspace.root, "packages/library/src/answer.d.ts"),
      "export declare const ANSWER: string;\n",
    );
    const printed = yield* runCheck(workspace, "packages/app/index.ts");
    expect(printed).toContain("[type-check] src/index.ts:3:31: error TS2551");
    expect(printed).not.toContain("lowercaseConstant");
  }).pipe(Effect.scoped),
);

export const passesWithTrackedFilesMissingFromTheWorkingTree = Task.make(
  "a tracked symbolic link whose target is gone and a file that sparse checkout leaves out of the working tree are not listed, so every task passes",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* linkNodeModulesWithCheck(root);
    yield* writtenFiles(root, {
      ...(yield* workspacePackage("", path.basename(root), ["src/**/*.ts"])),
      ".gitignore": "node_modules\nindex.ts\noxlint.config.ts\noxfmt.config.ts\n",
      "src/index.ts": "export const MAIN = 1;\n",
      "src/sparse.ts": "export const SPARSE = 1;\n",
    });
    yield* Task.exec("git", ["init", "--quiet"], { cwd: root });
    yield* Task.exec("bun", ["fmt", "."], {
      cwd: root,
    });
    yield* fileSystem.symlink("missing.ts", path.join(root, "src/gone.ts"));
    for (const gitArguments of [
      ["add", "--all"],
      ["update-index", "--skip-worktree", "src/sparse.ts"],
    ]) {
      yield* Task.exec("git", gitArguments, { cwd: root });
    }
    yield* fileSystem.remove(path.join(root, "src/sparse.ts"));
    const printed = yield* runCheck(
      { root, taskStateDirectory: yield* fileSystem.makeTempDirectoryScoped() },
      "index.ts",
    );
    expect(printed).not.toContain("NotFound");
    expect(printed).not.toContain(" error ");
    expect(printed).toContain("passed: ");
  }).pipe(Effect.scoped),
);

export const packageFilesStopAtNestedPackages = Task.make(
  "the listed and compiled files of a package leave out directories whose package.json names a package, but not directories whose package.json only marks a module type",
  Effect.gen(function* () {
    const { directory, tsconfigFile } = yield* makeProject({
      "package.json": '{ "name": "outer" }\n',
      "main.ts":
        'import { INNER } from "./inner/inner.ts";\nimport { MARKED } from "./marked/marked.ts";\nexport const MAIN = INNER + MARKED;\n',
      "inner/package.json": '{ "name": "inner" }\n',
      "inner/inner.ts": "export const INNER = 1;\n",
      "marked/package.json": '{ "type": "module" }\n',
      "marked/marked.ts": "export const MARKED = 1;\n",
      ".gitignore": "node_modules\n",
    });
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    expect(yield* listedPackageFiles(directory, [])).toEqual({
      packageFiles: [
        ".gitignore",
        "main.ts",
        "marked/marked.ts",
        "marked/package.json",
        "oxlint.config.ts",
        "package.json",
        "tsconfig.json",
      ],
      nestedPackageDirectories: ["inner"],
    });
    expect(yield* programFiles(tsconfigFile)).toEqual([
      "main.ts",
      "marked/marked.ts",
      "oxlint.config.ts",
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const packageFilesReadNestedManifestsLikeTheOtherChecks = Task.make(
  'the listed files of a package read a directory named package.json as no package.json, a nested package.json with no name as no package, and one that starts with a UTF-8 byte order mark as Node and oxc read it, while one whose name is no string, such as { "name": 5 }, one that is no JSON and one that cannot be read fail the listing with PackageManifestUnreadable naming it and why on one line, in the same words as the import-boundary check and no-re-exports',
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const listingOf = (files: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        for (const [file, text] of Object.entries(files)) {
          yield* fileSystem.makeDirectory(path.dirname(path.join(directory, file)), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(path.join(directory, file), text);
        }
        yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
        return { directory, listing: listedPackageFiles(directory, []) };
      });
    const unnamed = yield* listingOf({
      "package.json": '{ "name": "outer" }\n',
      "folder/a.ts": "export const A = 1;\n",
      "folder/package.json/note.txt": "a directory named package.json\n",
      "typed/package.json": '{ "type": "module" }\n',
      "typed/b.ts": "export const B = 1;\n",
      "marked/package.json": "\uFEFF{}\n",
      "marked/c.ts": "export const C = 1;\n",
      "named/package.json": '\uFEFF{"name":"x"}\n',
      "named/d.ts": "export const D = 1;\n",
    });
    expect(yield* unnamed.listing).toEqual({
      packageFiles: [
        "folder/a.ts",
        "folder/package.json/note.txt",
        "marked/c.ts",
        "marked/package.json",
        "package.json",
        "typed/b.ts",
        "typed/package.json",
      ],
      nestedPackageDirectories: ["named"],
    });
    for (const [manifest, reason] of [
      ['{ "name": 5 }\n', 'Expected string at ["name"]'],
      ["{ name: bad }\n", "Expected a valid JSON string"],
      ['{ "name": "locked" }\n', "reading it failed with EACCES"],
    ] as const) {
      const bad = yield* listingOf({
        "package.json": '{ "name": "outer" }\n',
        "bad/package.json": manifest,
        "bad/c.ts": "",
      });
      const manifestFile = path.join(bad.directory, "bad/package.json");
      const isLocked = reason === "reading it failed with EACCES";
      if (isLocked) {
        yield* fileSystem.chmod(manifestFile, NO_PERMISSIONS);
      }
      const failure = yield* bad.listing.pipe(
        failureAsValue,
        Effect.map((error) => [
          error._tag,
          "location" in error ? error.location : "no location",
          error.message,
        ]),
      );
      if (isLocked) {
        yield* fileSystem.chmod(manifestFile, OWNER_WRITES_EVERYONE_READS);
      }
      expect(failure).toEqual([
        "PackageManifestUnreadable",
        manifestFile,
        `cannot be read as a package.json whose name, if any, is a string: ${reason}`,
      ]);
    }
  }).pipe(Effect.scoped),
);

export const resolvesToolBinariesFromTheCheckedPackage = Task.make(
  "tool binaries resolve from the checked package, a string bin names the package's own binary, and a missing bin or package is a named failure",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* writtenFiles(directory, {
      "package.json": '{ "name": "consumer" }\n',
      "node_modules/string-bin-tool/package.json":
        '{ "name": "string-bin-tool", "bin": "cli.js" }\n',
      "node_modules/no-bin-tool/package.json": '{ "name": "no-bin-tool" }\n',
      "node_modules/bad-manifest-tool/package.json": '{ "name": "bad-manifest-tool", "bin": 1 }\n',
    });
    expect(yield* installedBinary(directory, "string-bin-tool", "string-bin-tool")).toBe(
      path.join(directory, "node_modules/string-bin-tool/cli.js"),
    );
    const withoutBinary = yield* installedBinary(directory, "no-bin-tool", "no-bin-tool").pipe(
      failureAsValue,
    );
    expect(withoutBinary._tag).toBe("InstalledPackageHasNoBinary");
    const notInstalled = yield* installedBinary(directory, "missing-tool", "missing-tool").pipe(
      failureAsValue,
    );
    expect(notInstalled._tag).toBe("PackageNotInstalled");
    const undecodable = yield* installedBinary(
      directory,
      "bad-manifest-tool",
      "bad-manifest-tool",
    ).pipe(failureAsValue);
    expect(undecodable._tag).toBe("PackageManifestFieldInvalid");
    expect(taggedViolations([undecodable])[0]).toStartWith(
      `${path.join(directory, "node_modules/bad-manifest-tool/package.json")}: error PackageManifestFieldInvalid: has a field of an unexpected type: `,
    );
    expect(notInstalled.message).toStartWith(`missing-tool does not resolve from ${directory}: `);
  }).pipe(Effect.scoped),
);
