import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Predicate } from "effect";

import {
  packageRootViolations,
  pathViolations,
  permissionGrantViolations,
  sourceViolations,
} from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import {
  fileTypeViolations,
  findFileTypeViolations,
} from "../../src/lib/tasks/lib/enforce-file-types/internal/find-file-type-violations.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { recordedGrantsOf } from "../../src/shared/record-and-grant-permissions-by-path.ts";
import {
  makeProject as makeProjectWith,
  RUNNER,
  writtenFiles,
  stagedCheckModule,
} from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const FILE_TYPES_TASK = stagedCheckModule("src/lib/tasks/lib/enforce-file-types/index.ts");

export const foreignCodeAndUnknownFilesNeedExactGrants = Task.make(
  "foreign source languages and unknown data formats need an exact file-type grant while TypeScript, TSX, Markdown and named tools pass",
  Effect.sync(() => {
    const exceptional = [
      "src/native.c",
      "src/native.cpp",
      "src/native.rs",
      "src/report.py",
      "src/build.sh",
      "src/build.bash",
      "src/legacy.js",
      "src/legacy.jsx",
      "src/module.mjs",
      "src/module.cjs",
      "src/module.mts",
      "src/module.cts",
      "src/data.json",
      "src/data.unknown",
      "src/no-extension",
      "Dockerfile",
      "Makefile",
      ".eslintrc.cjs",
      ".gitattributes",
      ".editorconfig",
      ".gitmodules",
      "NOTICE",
      ".github/CODEOWNERS",
      "tsconfig.other.json",
      "README.MD",
      "notes.markdown",
    ];
    const permitted = [
      "src/index.ts",
      "src/components/view.tsx",
      "docs/guide.md",
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.json",
      "tsconfig.build.json",
      "oxlint.config.ts",
      "oxfmt.config.ts",
      "vite.config.ts",
      "bun-env.d.ts",
      ".gitignore",
      "LICENSE",
    ];
    expect(
      fileTypeViolations([...permitted, ...exceptional], []).map(({ location }) => location),
    ).toEqual(exceptional);
    expect(
      fileTypeViolations(
        ["src/native.c", "src/other.c"],
        [{ path: "src/native.c", allow: ["hasAnUnlistedFileType"] }],
      ).map(({ location }) => location),
    ).toEqual(["src/other.c"]);
    expect(
      fileTypeViolations(["src/native.c"], [{ path: "src", allow: ["isAnUnlistedDirectory"] }]).map(
        ({ location }) => location,
      ),
    ).toEqual(["src/native.c"]);
  }),
);

export const aFileInAGrantedDirectoryNeedsItsOwnFileTypeGrant = Task.make(
  "a file type inside a granted directory still needs its own grant",
  Effect.sync(() => {
    const workflow = ".github/workflows/publish.yml";
    const directoryGrant = { path: ".github", allow: ["isAnUnlistedDirectory" as const] };
    expect(
      fileTypeViolations([workflow], [directoryGrant]).map(({ location }) => location),
    ).toEqual([workflow]);
    expect(
      fileTypeViolations(
        [workflow],
        [directoryGrant, { path: workflow, allow: ["hasAnUnlistedFileType"] }],
      ),
    ).toEqual([]);
  }),
);

export const toolLocationsRemainIndependentOfTypeGrants = Task.make(
  "supported tool names have precise locations and a file-type grant does not move code or a tool file",
  Effect.sync(() => {
    for (const path of [
      "tsconfig.json",
      "src/internal/tsconfig.json",
      "scripts/tsconfig.json",
      "referenced/tsconfig.build.json",
      "oxlint.config.ts",
      "Dockerfile",
      "README.md",
      "src/README.md",
    ]) {
      expect(pathViolations(path)).toEqual([]);
    }
    for (const path of [
      "scripts/oxlint.config.ts",
      "docs/Dockerfile",
      "src/LICENSE",
      "src/bun.lock",
    ]) {
      expect(pathViolations(path).map(({ _tag }) => _tag)).toEqual(["MisplacedToolFile"]);
      expect(fileTypeViolations([path], [{ path, allow: ["hasAnUnlistedFileType"] }])).toEqual([]);
    }
    for (const path of ["unknown.config.ts", ".custom.ts", "globals.d.ts"]) {
      expect(fileTypeViolations([path], [])).toEqual([]);
      expect(sourceViolations(path, "export {};\n").map(({ _tag }) => _tag)).toEqual([
        "MisplacedAtPackageRoot",
      ]);
    }
    expect(pathViolations("src/native.py")).toEqual([]);
    expect(sourceViolations("scripts/oxlint.config.ts", "export {};\n")).toEqual([]);
    expect(pathViolations("src/oxlint.config.ts")[0]?.message).toBe(
      "is a tool file that belongs in the package root",
    );
    expect(
      packageRootViolations(["docs/tsconfig.json", "docs/Dockerfile"]).map(
        ({ location }) => location,
      ),
    ).toEqual(["docs/tsconfig.json"]);
  }),
);

export const exceptionalFileGrantsUseExistingValidation = Task.make(
  "file-type grants reject missing paths and directories, and a Markdown file may be granted its file type",
  Effect.sync(() => {
    expect(
      permissionGrantViolations(
        ["src/index.ts"],
        [
          {
            path: "missing.c",
            allow: ["hasAnUnlistedFileType"],
            services: [],
            cannotImport: [],
          },
          { path: "src", allow: ["hasAnUnlistedFileType"], services: [], cannotImport: [] },
        ],
      ).map(({ _tag }) => _tag),
    ).toEqual(["GrantedPathMissing", "DirectoryGrantedPermissions"]);
    const grants = recordedGrantsOf({ "notes.markdown": { allow: ["hasAnUnlistedFileType"] } });
    expect(grants).toMatchObject({
      grants: [{ path: "notes.markdown", allow: ["hasAnUnlistedFileType"] }],
    });
    expect(
      fileTypeViolations(
        ["notes.markdown"],
        [{ path: "notes.markdown", allow: ["hasAnUnlistedFileType"] }],
      ),
    ).toEqual([]);
  }),
);

export const listedPackageFilesDriveTheTypeCheck = Task.make(
  "the file types of a package cover its tracked and untracked files, skip ignored files, leave the files of a nested package to that package's own run, and read exact grants",
  Effect.gen(function* () {
    const { directory } = yield* makeProject(
      {
        "src/index.ts": "export {};\n",
        ".gitignore": "ignored/\nnode_modules/\n",
        "src/tracked.c": "",
        "src/untracked.rs": "",
        "ignored/hidden.py": "",
        "nested/package.json": '{"name":"nested"}',
        "nested/native.cpp": "",
      },
      'lintConfig({ "src/tracked.c": { allow: ["hasAnUnlistedFileType"] } })',
    );
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    yield* Task.exec("git", ["add", "src/tracked.c"], { cwd: directory });
    const failure = yield* findFileTypeViolations(directory).pipe(failureAsValue);
    expect(Predicate.isTagged(failure, "FileTypeViolations")).toBe(true);
    if (Predicate.isTagged(failure, "FileTypeViolations")) {
      expect(failure.violations).toMatchObject([{ location: "src/untracked.rs", fileType: ".rs" }]);
    }
    yield* writtenFiles(directory, { "oxlint.config.ts": "not a valid config\n" });
    expect(yield* findFileTypeViolations(directory)).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const untrackedForbiddenFilesFailTheNextRun = Task.make(
  "a file-type task that passed reports a new untracked C file on its next run",
  Effect.gen(function* () {
    const { directory, taskStateDirectory } = yield* makeProject({
      "src/index.ts": "export {};\n",
      ".gitignore": "node_modules\nrun.ts\n",
    });
    yield* writtenFiles(directory, {
      "run.ts": `import { Task } from ${yield* encodeJson(RUNNER)};\nimport { fileTypes } from ${yield* encodeJson(FILE_TYPES_TASK)};\nTask.main(fileTypes);\n`,
    });
    const options = { cwd: directory, taskStateDirectory };
    expect(yield* runTaskFile("bun run.ts", options)).toContain("[file-types] passed");
    yield* writtenFiles(directory, { "src/untracked.c": "" });
    const failure = yield* runTaskFile("bun run.ts", options).pipe(failureAsValue);
    expect(failure.message).toContain("src/untracked.c");
    expect(failure.message).toContain("FileTypeNotGranted");
  }).pipe(Effect.scoped),
);

export const patchFilesNeedOnlyAPatchGrant = Task.make(
  "a .patch file that package.json lists and that is granted patchesADependency, itself or through its directory, needs no file-type grant, while an unlisted .patch file beside it, another file in that directory and an ungranted patch still do",
  Effect.sync(() => {
    expect(
      fileTypeViolations(
        [
          "patches/effect@4.1.0.patch",
          "patches/@effect%2Fsql-sqlite-bun@4.1.0.patch",
          "patches/notes.patch",
          "patches/notes.txt",
          "fixes/is-number.patch",
          "other/is-odd.patch",
        ],
        [
          { path: "patches", allow: ["patchesADependency"] },
          { path: "fixes/is-number.patch", allow: ["patchesADependency"] },
        ],
        new Set([
          "patches/effect@4.1.0.patch",
          "patches/@effect%2Fsql-sqlite-bun@4.1.0.patch",
          "fixes/is-number.patch",
          "other/is-odd.patch",
        ]),
      ).map(({ location }) => location),
    ).toEqual(["patches/notes.patch", "patches/notes.txt", "other/is-odd.patch"]);
  }),
);

export const fileTypesReadThePatchesTheManifestLists = Task.make(
  "the file-type check reads patchedDependencies from the package's package.json, so a granted patch directory passes the patch it lists and not an unlisted one beside it",
  Effect.gen(function* () {
    const { directory } = yield* makeProject(
      {
        "src/index.ts": "export {};\n",
        ".gitignore": "node_modules/\n",
        "package.json": yield* encodeJson({
          name: "patched",
          patchedDependencies: { "effect@4.1.0": "patches/effect@4.1.0.patch" },
        }),
        "patches/effect@4.1.0.patch": "",
        "patches/notes.patch": "",
      },
      'lintConfig({ patches: { allow: ["patchesADependency"] } })',
    );
    const failure = yield* findFileTypeViolations(directory).pipe(failureAsValue);
    expect(Predicate.isTagged(failure, "FileTypeViolations")).toBe(true);
    if (Predicate.isTagged(failure, "FileTypeViolations")) {
      expect(failure.violations).toMatchObject([
        { location: "patches/notes.patch", fileType: ".patch" },
      ]);
    }
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);
