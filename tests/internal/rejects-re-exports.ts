import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import {
  findIndexReExportViolations,
  indexReExportJudgmentsOf,
} from "../../src/lib/tasks/lib/judge-index-re-exports/internal/find-index-re-export-violations.ts";
import { moduleResolverFor } from "../../src/lib/tasks/shared/create-the-module-resolver.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  makeProject,
  NO_PERMISSIONS,
  OWNER_WRITES_EVERYONE_READS,
  writtenFiles,
} from "../shared/checked-project.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const judgedCase = (reExportCase: {
  readonly code: string;
  readonly filename: string;
  readonly errors?: readonly { readonly message: string }[];
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(reExportCase.filename), { recursive: true });
    yield* fileSystem.writeFileString(reExportCase.filename, reExportCase.code);
    const judgments = yield* indexReExportJudgmentsOf(reExportCase.filename, reExportCase.code);
    return {
      reported: {
        code: reExportCase.code,
        filename: reExportCase.filename,
        messages: judgments.map(({ judgment }) => judgment),
      },
      expected: {
        code: reExportCase.code,
        filename: reExportCase.filename,
        messages: (reExportCase.errors ?? []).map(({ message }) => message),
      },
    };
  });

const reExportsCheckTest = (cases: {
  readonly valid: readonly { readonly code: string; readonly filename: string }[];
  readonly invalid: readonly {
    readonly code: string;
    readonly filename: string;
    readonly errors: readonly { readonly message: string }[];
  }[];
}) =>
  Effect.gen(function* () {
    const judged = yield* Effect.forEach([...cases.valid, ...cases.invalid], judgedCase);
    expect(judged.map(({ reported }) => reported)).toEqual(judged.map(({ expected }) => expected));
  });

const reExport = (exported: string, binding: string, source: string) =>
  `export ${exported} re-exports ${binding}, imported from ${source}`;

const initializedTo = (exported: string, binding: string, source: string) =>
  `export ${exported} is initialized to ${binding}, imported from ${source}`;

const reExportMember = (exported: string, member: string, binding: string, source: string) =>
  `export ${exported} re-exports ${member}, a member of ${binding} imported from ${source}`;

const initializedToMember = (exported: string, member: string, binding: string, source: string) =>
  `export ${exported} is initialized to ${member}, a member of ${binding} imported from ${source}`;

export const exportsAreDefinedWhereTheyAreWritten = Task.make(
  "no-re-exports rejects export from outside an index, export *, export { } or export default naming an imported binding, export default of a direct member of an imported binding by a static or computed key, export import x = require() and export =, and an exported variable declaration initialized to such a binding or member, while exports a file declares itself stay allowed",
  ruleTest("no-re-exports", {
    valid: [
      "export const VALUE = 1;",
      "const VALUE = 1; export { VALUE };",
      "const VALUE = 1; export { VALUE as RENAMED };",
      "export default function run() {}",
      "const run = () => 1; export default run;",
      'import { make } from "./make.ts"; export const run = () => make();',
      'import { LIMIT } from "./limits.ts"; export const DOUBLE_LIMIT = LIMIT * 2;',
      'import type { Shape } from "./shape.ts"; export const read = (shape: Shape) => shape;',
      'import * as values from "./values.ts"; export const FIRST = values.list[0];',
      'import { make } from "./make.ts"; export default make();',
      "import Shapes = Geometry.Shapes;",
      "export import Shapes = Geometry.Shapes;",
    ],
    invalid: [
      {
        code: 'import { run } from "./internal/task.ts"; export const start = run;',
        errors: [{ message: initializedTo("start", "run", "./internal/task.ts") }],
      },
      {
        code: 'import { VALUE } from "./values.ts"; export const ALIAS = VALUE;',
        errors: [{ message: initializedTo("ALIAS", "VALUE", "./values.ts") }],
      },
      {
        code: 'import * as values from "./values.ts"; export const VALUES = values;',
        errors: [{ message: initializedTo("VALUES", "values", "./values.ts") }],
      },
      {
        code: 'export { run } from "./internal/task.ts";',
        filename: "src/task.ts",
        errors: [
          {
            message: "export from ./internal/task.ts re-exports another module",
          },
        ],
      },
      {
        code: 'export * from "./internal/task.ts";',
        filename: "src/index.ts",
        errors: [{ message: "export * from ./internal/task.ts re-exports another module" }],
      },
      {
        code: 'export * as task from "./internal/task.ts";',
        filename: "src/task.ts",
        errors: [{ message: "export * from ./internal/task.ts re-exports another module" }],
      },
      {
        code: 'export import task = require("./internal/task.ts");',
        filename: "src/index.ts",
        errors: [{ message: "export import task re-exports another module" }],
      },
      {
        code: "const run = () => 1; export = run;",
        filename: "src/index.ts",
        errors: [{ message: "export = replaces the module's exports" }],
      },
      {
        code: 'export { VALUE } from "./values.ts";',
        errors: [
          {
            message: "export from ./values.ts re-exports another module",
          },
        ],
      },
      {
        code: 'export type { Shape } from "./shape.ts";',
        errors: [
          {
            message: "export from ./shape.ts re-exports another module",
          },
        ],
      },
      {
        code: 'export * from "./values.ts";',
        errors: [{ message: "export * from ./values.ts re-exports another module" }],
      },
      {
        code: 'export * as values from "./values.ts";',
        errors: [{ message: "export * from ./values.ts re-exports another module" }],
      },
      {
        code: 'import { VALUE } from "./values.ts"; export { VALUE };',
        errors: [{ message: reExport("VALUE", "VALUE", "./values.ts") }],
      },
      {
        code: 'import { VALUE as SOURCE } from "./values.ts"; export { SOURCE as VALUE };',
        errors: [{ message: reExport("VALUE", "SOURCE", "./values.ts") }],
      },
      {
        code: 'import type { Shape } from "./shape.ts"; export type { Shape };',
        errors: [{ message: reExport("Shape", "Shape", "./shape.ts") }],
      },
      {
        code: 'import * as values from "./values.ts"; export { values };',
        errors: [{ message: reExport("values", "values", "./values.ts") }],
      },
      {
        code: 'import run from "./run.ts"; export default run;',
        errors: [{ message: reExport("default", "run", "./run.ts") }],
      },
      {
        code: 'import * as values from "./values.ts"; export default values.VALUE;',
        errors: [{ message: reExportMember("default", "values.VALUE", "values", "./values.ts") }],
      },
      {
        code: 'import * as values from "./values.ts"; export default values["VALUE"];',
        errors: [
          { message: reExportMember("default", 'values["VALUE"]', "values", "./values.ts") },
        ],
      },
      {
        code: 'export import values = require("./values");',
        errors: [{ message: "export import values re-exports another module" }],
      },
      {
        code: "const run = () => 1; export = run;",
        errors: [{ message: "export = replaces the module's exports" }],
      },
    ],
  }),
);

export const onlyADirectMemberOfAnImportIsReExported = Task.make(
  "no-re-exports reports export default of a direct static member of an imported binding, whether a namespace, named or default import, naming the export and the binding, while a member of a member, destructuring and import x = require() bindings are not followed",
  ruleTest("no-re-exports", {
    valid: [
      'import { data } from "./data.ts"; export default data.items.length;',
      'import * as values from "./values.ts"; export default values.group.VALUE;',
      'import * as ns from "./ns.ts"; export const { run } = ns;',
      'import tools = require("./tools.ts"); export { tools };',
      'import { make } from "./make.ts"; export const run = (make: () => number) => make;',
    ],
    invalid: [
      {
        code: 'import * as ns from "./ns.ts"; export default ns.run;',
        errors: [{ message: reExportMember("default", "ns.run", "ns", "./ns.ts") }],
      },
      {
        code: 'import { NAMES } from "./names.ts"; export default NAMES.length;',
        errors: [{ message: reExportMember("default", "NAMES.length", "NAMES", "./names.ts") }],
      },
      {
        code: 'import { Effect } from "effect"; export default Effect.void;',
        errors: [{ message: reExportMember("default", "Effect.void", "Effect", "effect") }],
      },
      {
        code: 'import tools from "./tools.ts"; export default tools["run"];',
        errors: [{ message: reExportMember("default", 'tools["run"]', "tools", "./tools.ts") }],
      },
    ],
  }),
);

const INDEX_FIXTURE_FILES = [
  "src/a/index.ts",
  "src/a/index.tsx",
  "src/a/a.ts",
  "src/a/child/index.ts",
  "src/a/internal/a.ts",
  "src/a/internal/view.tsx",
  "src/a/internal/index.ts",
  "src/a/internal/shape.d.ts",
  "src/a/internal/legacy.js",
  "src/a/internal/data.json",
  "src/a/internal/sub/a.ts",
  "src/a/internal/sub/index.ts",
  "src/a/shared/a.ts",
  "src/a/shared/index.tsx",
  "src/a/shared/sub/a.ts",
  "src/internal/a.ts",
  "src/b/internal/x.ts",
  "src/d/internal/a.ts",
  "src/c/index.ts",
  "src/c/internal/a.ts",
  "src/e/index.ts",
  "src/e/internal/a.ts",
  "src/f/index.ts",
  "src/f/shared/a.ts",
  "src/g/index.ts",
  "src/g/internal/a.ts",
  "src/h/index.ts",
  "src/h/internal/a.ts",
  "node_modules/pkg/index.js",
  "../hoisted/index.ts",
  "packages/lib/index.ts",
] as const;

const OUTSIDE_LAYOUT = "a file outside this index's own internal/ and shared/";

const exportFrom = (source: string) => `export { run } from "${source}";`;

export const anIndexReExportIsJudgedByTheFileItResolvesTo = Task.make(
  'the re-exports check resolves an index\'s export from path with the import-boundary check\'s resolver setup and states the one fact that is wrong about the real file it resolves to: a package or built-in under any of its names, bun: included, a file outside the index\'s own internal/ and shared/, a file in a subdirectory of them, an index file, a declaration file, or a file without a .ts or .tsx extension, so a trailing slash, /.. above the root, file:// URLs and symlinks mean what the resolver makes of them, a symlinked index resolves from its target, a hoisted dependency, a workspace package behind a node_modules symlink and a directory whose package.json has a string name are packages, while a package.json without one, such as { "type": "module" }, makes no package, an unknown bun: or node: module and a path that resolves to no file are left to the import-boundary check and the type check, and a project inside a node_modules directory is judged like any other; a renaming is reported only when the file is allowed, so not for a path that resolves to no file',
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(
      yield* fileSystem.makeTempDirectoryScoped(),
      "node_modules/project",
    );
    const manifests = {
      "node_modules/pkg/package.json": '{ "name": "pkg", "exports": { ".": "./index.js" } }',
      "../hoisted/package.json": '{ "name": "hoisted", "exports": { ".": "./index.ts" } }',
      "packages/lib/package.json": '{ "name": "@ws/lib", "exports": { ".": "./index.ts" } }',
      "src/c/package.json": '{ "type": "module" }',
      "src/e/internal/package.json": '{ "type": "module" }',
      "src/f/shared/package.json": '{ "type": "commonjs" }',
      "src/g/internal/package.json": '{ "sideEffects": false }',
      "src/h/internal/package.json": '{ "name": "nested" }',
    };
    for (const file of [...INDEX_FIXTURE_FILES, ...Object.keys(manifests)]) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(directory, file),
        Object.entries(manifests).find(([manifest]) => manifest === file)?.[1] ??
          "export const run = 1;\n",
      );
    }
    yield* fileSystem.symlink(
      "../../b/internal/x.ts",
      path.join(directory, "src/a/internal/link.ts"),
    );
    yield* fileSystem.symlink("../a/index.ts", path.join(directory, "src/d/index.ts"));
    yield* fileSystem.makeDirectory(path.join(directory, "node_modules/@ws"));
    yield* fileSystem.symlink("../../packages/lib", path.join(directory, "node_modules/@ws/lib"));
    const index = path.join(directory, "src/a/index.ts");
    const internalFile = path.join(directory, "src/a/internal/a.ts");
    const reported = (source: string, fact: string, filename = index) => ({
      code: exportFrom(source),
      filename,
      errors: [{ message: `export from ${source} ${fact}` }],
    });
    const indexIn = (module: string) => path.join(directory, `src/${module}/index.ts`);
    return yield* reExportsCheckTest({
      valid: [
        ...[
          "./internal/a.ts",
          "./shared/a.ts",
          "./internal/view.tsx",
          "./internal/../shared/a.ts",
          "./internal//a.ts",
          "./internal/./a.ts",
          "../a/internal/a.ts",
          "./internal/a.ts/.",
          "./internal/a.ts/x/..",
          "./internal/a",
          "./internal/a.js",
          "./internal/A.ts",
          "./internal/a.ts/",
          "./internal/missing.ts",
          "missing-package",
          "bun:nope",
          "node:nope",
          "pkg/index.js",
          `/..${internalFile}`,
          `file://${internalFile}`,
          internalFile,
        ].map((source) => ({ code: exportFrom(source), filename: index })),
        ...[
          ["d", "./internal/a.ts"],
          ["c", "./internal/a.ts"],
          ["e", "./internal/a.ts"],
          ["f", "./shared/a.ts"],
          ["g", "./internal/a.ts"],
        ].map(([module = "", source = ""]) => ({
          code: exportFrom(source),
          filename: indexIn(module),
        })),
        { code: 'export { run, default } from "./internal/a.ts";', filename: index },
        { code: 'export { run as start } from "./internal/missing.ts";', filename: index },
        {
          code: 'export { type Shape, run } from "./shared/a.ts";',
          filename: path.join(directory, "src/a/index.tsx"),
        },
      ],
      invalid: [
        ...[
          "pkg",
          "hoisted",
          "@ws/lib",
          "node:fs",
          "fs",
          "bun",
          "bun:test",
          "bun:sqlite",
          "bun:fs",
          "bun:path",
          "bun:child_process",
        ].map((source) => reported(source, "re-exports a package or built-in")),
        ...[
          "./a.ts",
          "../internal/a.ts",
          "./child/index.ts",
          "./internal/../../b/internal/x.ts",
          "./shared/../a.ts",
          "./internal/link.ts",
        ].map((source) => reported(source, `re-exports ${OUTSIDE_LAYOUT}`)),
        reported("./internal/a.ts", "re-exports a package or built-in", indexIn("h")),
        reported("../b/internal/x.ts", `re-exports ${OUTSIDE_LAYOUT}`, indexIn("c")),
        reported("./internal/sub/a.ts", "re-exports a file in a subdirectory of internal/"),
        reported("./internal/./sub//a.ts", "re-exports a file in a subdirectory of internal/"),
        reported("./shared/sub/a.ts/.", "re-exports a file in a subdirectory of shared/"),
        ...[
          "./internal/index.ts",
          "./shared/index.tsx",
          "./internal/",
          "./internal",
          "./internal/.",
          "./internal/a.ts/..",
          "./internal/index.ts/x/..",
        ].map((source) => reported(source, "re-exports an index file")),
        reported("./internal/shape.d.ts", "re-exports a declaration file"),
        reported("./internal/shape", "re-exports a declaration file"),
        reported("./internal/legacy.js", "re-exports a file without a .ts or .tsx extension"),
        reported("./internal/data.json", "re-exports a file without a .ts or .tsx extension"),
        {
          code: 'export { run as start } from "./internal/a.ts";',
          filename: index,
          errors: [{ message: "export from ./internal/a.ts renames run to start" }],
        },
        {
          code: 'export { run as start } from "./a.ts";',
          filename: index,
          errors: [{ message: `export from ./a.ts re-exports ${OUTSIDE_LAYOUT}` }],
        },
      ],
    });
  }).pipe(Effect.scoped),
);

export const aDirectoryNamedPackageJsonMakesNoPackage = Task.make(
  "the re-exports check reads a directory named package.json as no package.json, like the import-boundary check and the resolver, so it makes no package and the rule still judges the index's export from",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const files = [
      "package.json",
      "src/a/index.ts",
      "src/a/a.ts",
      "src/a/internal/a.ts",
      "src/c/index.ts",
      "src/c/a.ts",
      "src/c/internal/a.ts",
    ];
    for (const file of files) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(directory, file),
        file.endsWith(".json") ? '{ "name": "p" }' : "export const run = 1;\n",
      );
    }
    yield* fileSystem.makeDirectory(path.join(directory, "src/a/internal/package.json"));
    yield* fileSystem.makeDirectory(path.join(directory, "src/c/package.json"));
    const indexIn = (module: string) => path.join(directory, `src/${module}/index.ts`);
    yield* reExportsCheckTest({
      valid: ["a", "c"].map((module) => ({
        code: exportFrom("./internal/a.ts"),
        filename: indexIn(module),
      })),
      invalid: ["a", "c"].map((module) => ({
        code: exportFrom("./a.ts"),
        filename: indexIn(module),
        errors: [{ message: `export from ./a.ts re-exports ${OUTSIDE_LAYOUT}` }],
      })),
    });
  }).pipe(Effect.scoped),
);

const RUN = "export const run = 1;\n";
const GIT_HEAD = "ref: refs/heads/main\n";

const unjudged = (source: string, manifest: string, reason: string) =>
  `export from ${source} cannot be judged, since ${manifest} cannot be read as a package.json: ${reason}`;

export const aBadPackageJsonIsReported = Task.make(
  "the re-exports check reports an index's export from when a package.json it reads to find the index's package or the resolved file's cannot be read, is a symlink to itself, is no JSON, or has a name that is no string, such as { \"name\": 5 }, naming that package.json relative to the index's directory and why, in the same words as the import-boundary check and the file listing, instead of reading it as unnamed or crashing, while a package.json that starts with a UTF-8 byte order mark is read as Node and oxc read it",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* writtenFiles(directory, {
      "package.json": '{ "name": "p" }',
      "src/b/internal/package.json": '{ "name": "b" }',
      "src/d/internal/package.json": '{ "name": 5 }',
      "src/e/internal/package.json": "{ name: e }",
      "src/f/package.json": '{ "name": null }',
      "src/g/internal/package.json": "\uFEFF{}\n",
      "src/h/package.json": '\uFEFF{"name":"x"}\n',
      ...Object.fromEntries(
        ["b", "d", "e", "f", "g", "h", "i"].map((module) => [`src/${module}/internal/a.ts`, RUN]),
      ),
    });
    const unreadable = path.join(directory, "src/b/internal/package.json");
    yield* fileSystem.chmod(unreadable, NO_PERMISSIONS);
    yield* fileSystem.symlink("package.json", path.join(directory, "src/i/internal/package.json"));
    const exportIn = (module: string) => ({
      code: exportFrom("./internal/a.ts"),
      filename: path.join(directory, `src/${module}/index.ts`),
    });
    const badManifest = (module: string, manifest: string, reason: string) => ({
      ...exportIn(module),
      errors: [{ message: unjudged("./internal/a.ts", manifest, reason) }],
    });
    yield* reExportsCheckTest({
      valid: [exportIn("g"), exportIn("h")],
      invalid: [
        badManifest("b", "./internal/package.json", "reading it failed with EACCES"),
        badManifest("d", "./internal/package.json", 'Expected string at ["name"]'),
        badManifest("e", "./internal/package.json", "Expected a valid JSON string"),
        badManifest("f", "./package.json", 'Expected string at ["name"]'),
        badManifest("i", "./internal/package.json", "reading it failed with ELOOP"),
      ],
    });
    yield* fileSystem.chmod(unreadable, OWNER_WRITES_EVERYONE_READS);
  }).pipe(Effect.scoped),
);

export const aResolutionErrorIsExplainedByThePackageJsonsAround = Task.make(
  "when the resolver finds no file but fails, no-re-exports reads the package.json files around the index and, for a relative path, around its target, so a package.json that is no JSON is reported by its path even when the project's path holds a \" or a backslash, and a resolver failure that no package.json explains, such as an empty path or a package whose package.json is no JSON, is reported with the resolver's words instead of read as no file",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const projects = ['quo"te', String.raw`back\slash`].map((name) => path.join(directory, name));
    for (const project of projects) {
      yield* writtenFiles(project, {
        "package.json": '{ "name": "p" }',
        "src/m/internal/package.json": "{ name: bad }",
        "src/m/internal/a.ts": RUN,
        "node_modules/broken/package.json": "{ broken",
        "node_modules/broken/index.ts": RUN,
      });
    }
    const exportIn = (project: string, source: string) => ({
      code: exportFrom(source),
      filename: path.join(project, "src/m/index.ts"),
    });
    const resolverFailure = (project: string, source: string) =>
      Effect.tryPromise(() =>
        moduleResolverFor([]).resolveFileAsync(path.join(project, "src/m/index.ts"), source),
      ).pipe(Effect.map((resolved) => resolved.error ?? "no error"));
    const invalid = yield* Effect.forEach(projects, (project) =>
      Effect.gen(function* () {
        const unexplained = yield* Effect.forEach(["", "broken"], (source) =>
          resolverFailure(project, source).pipe(
            Effect.map((failure) => ({
              ...exportIn(project, source),
              errors: [
                {
                  message: `export from ${source} cannot be judged, since the resolver failed: ${failure}`,
                },
              ],
            })),
          ),
        );
        return [
          {
            ...exportIn(project, "./internal/a.ts"),
            errors: [
              {
                message: unjudged(
                  "./internal/a.ts",
                  "./internal/package.json",
                  "Expected a valid JSON string",
                ),
              },
            ],
          },
          ...unexplained,
        ];
      }),
    );
    yield* reExportsCheckTest({ valid: [], invalid: invalid.flat() });
  }).pipe(Effect.scoped),
);

export const aPackageJsonAboveTheProjectIsNeverRead = Task.make(
  "the re-exports check stops looking for the nearest package.json with a string name at the git repository's root, the nearest directory above the file that holds .git, so a package.json above a repository whose own package.json has no name is never read, even when it is no JSON",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const project = path.join(directory, "project");
    yield* writtenFiles(directory, {
      "package.json": "{ broken\n",
      "project/.git/HEAD": GIT_HEAD,
      "project/package.json": '{ "private": true }\n',
      "project/src/m/internal/a.ts": RUN,
      "project/src/m/a.ts": RUN,
    });
    yield* reExportsCheckTest({
      valid: [
        {
          code: exportFrom("./internal/a.ts"),
          filename: path.join(project, "src/m/index.ts"),
        },
      ],
      invalid: [
        {
          code: exportFrom("./a.ts"),
          filename: path.join(project, "src/m/index.ts"),
          errors: [{ message: `export from ./a.ts re-exports ${OUTSIDE_LAYOUT}` }],
        },
      ],
    });
  }).pipe(Effect.scoped),
);

export const theWorkingDirectoryNeverChangesAReport = Task.make(
  "the re-exports check bounds the search for the index's package and its target's by the git repository's root above each, found from the file alone, so it reports the same whatever directory it runs from, and never reads a package.json above the repository",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const projects = ["named", "unnamed"];
    yield* writtenFiles(directory, {
      "package.json": "{ broken\n",
      "named/package.json": '{ "name": "p" }\n',
      "unnamed/package.json": '{ "private": true }\n',
      ...Object.fromEntries(
        projects.flatMap((project) => [
          [`${project}/.git/HEAD`, GIT_HEAD],
          [`${project}/src/m/internal/a.ts`, RUN],
        ]),
      ),
    });
    yield* reExportsCheckTest({
      valid: projects.map((project) => ({
        code: exportFrom("./internal/a.ts"),
        filename: path.join(directory, project, "src/m/index.ts"),
      })),
      invalid: projects.map((project) => ({
        code: exportFrom("../m/internal/a.ts"),
        filename: path.join(directory, project, "src/n/index.ts"),
        errors: [{ message: `export from ../m/internal/a.ts re-exports ${OUTSIDE_LAYOUT}` }],
      })),
    });
  }).pipe(Effect.scoped),
);

export const anUnnamedPackageJsonNeverEndsTheSearch = Task.make(
  'the re-exports check judges an index and its target by the nearest package.json with a string name above each, so a package.json without a name between the index and the project\'s named one, such as src/package.json holding { "type": "module" }, leaves a target outside src/ in the index\'s package: it re-exports a file outside the layout, not a package',
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const project = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* writtenFiles(project, {
      ".git/HEAD": GIT_HEAD,
      "package.json": '{ "name": "p" }\n',
      "src/package.json": '{ "type": "module" }\n',
      "lib/a.ts": RUN,
      "src/other/a.ts": RUN,
      "src/m/internal/a.ts": RUN,
    });
    const index = path.join(project, "src/m/index.ts");
    const workingDirectories = [".", "src", "src/m"].map((directory) =>
      path.join(project, directory),
    );
    yield* reExportsCheckTest({
      valid: workingDirectories.map((workingDirectory) => ({
        code: exportFrom("./internal/a.ts"),
        filename: index,
        workingDirectory,
      })),
      invalid: workingDirectories.flatMap((workingDirectory) =>
        ["../../lib/a.ts", "../other/a.ts"].map((source) => ({
          code: exportFrom(source),
          filename: index,
          workingDirectory,
          errors: [{ message: `export from ${source} re-exports ${OUTSIDE_LAYOUT}` }],
        })),
      ),
    });
  }).pipe(Effect.scoped),
);

export const anExportInitializedToAnImportIsReported = Task.make(
  "no-re-exports reports an exported variable declaration, such as export const or export let, when the initializer is an imported binding or a direct static member of one, naming the export and the binding, while a member of a member and export import x = ns.sub are not followed, and export import x = require() re-exports another module",
  ruleTest("no-re-exports", {
    valid: [
      'import * as ns from "./ns.ts"; export const started = ns.group.run;',
      'import { Schema } from "effect"; export const Id = Schema.String.pipe(Schema.brand("Id"));',
      'import * as ns from "./ns.ts"; export import sub = ns.sub;',
    ],
    invalid: [
      {
        code: 'import { run } from "./run.ts"; export const started = run;',
        errors: [{ message: initializedTo("started", "run", "./run.ts") }],
      },
      {
        code: 'import { run } from "./run.ts"; export let started = run;',
        errors: [{ message: initializedTo("started", "run", "./run.ts") }],
      },
      {
        code: 'import * as ns from "./ns.ts"; export const started = ns.run, stopped = ns["stop"];',
        errors: [
          { message: initializedToMember("started", "ns.run", "ns", "./ns.ts") },
          { message: initializedToMember("stopped", 'ns["stop"]', "ns", "./ns.ts") },
        ],
      },
      {
        code: 'import * as Schema from "effect/Schema"; export const Id = Schema.String;',
        errors: [
          { message: initializedToMember("Id", "Schema.String", "Schema", "effect/Schema") },
        ],
      },
      {
        code: 'import { Schema } from "effect"; export const Id = Schema.String;',
        errors: [{ message: initializedToMember("Id", "Schema.String", "Schema", "effect") }],
      },
      {
        code: 'import { run } from "./run.ts"; export { run as started };',
        errors: [{ message: reExport("started", "run", "./run.ts") }],
      },
      {
        code: 'import { handler } from "./handler.ts"; export const GET = handler satisfies (request: Request) => Response;',
        errors: [{ message: initializedTo("GET", "handler", "./handler.ts") }],
      },
      {
        code: 'import * as ns from "./ns.ts"; export const started = ns.run as () => void;',
        errors: [{ message: initializedToMember("started", "ns.run", "ns", "./ns.ts") }],
      },
      {
        code: 'import { handler } from "./handler.ts"; export default handler satisfies Handler;',
        errors: [{ message: reExport("default", "handler", "./handler.ts") }],
      },
      {
        code: 'import { handler } from "./handler.ts"; const GET = handler; export { GET };',
        errors: [{ message: initializedTo("GET", "handler", "./handler.ts") }],
      },
      {
        code: 'import * as ns from "./ns.ts"; const run = ns.run; export default run;',
        errors: [{ message: initializedToMember("default", "ns.run", "ns", "./ns.ts") }],
      },
      {
        code: 'import { handler } from "./handler.ts"; const first = handler; export const GET = first;',
        errors: [{ message: initializedTo("GET", "handler", "./handler.ts") }],
      },
      {
        code: 'export import values = require("./values.ts");',
        errors: [{ message: "export import values re-exports another module" }],
      },
    ],
  }),
);

export const aMemberIsNamedByItsKeyAsWritten = Task.make(
  "no-re-exports follows an identifier, a string key or a template literal key without substitutions, and names a non-identifier export name as the source writes it and the member as the source writes it, with each line break printed as a backslash and n, while a numeric or bigint key, a template literal key with substitutions and destructuring stay unfollowed",
  ruleTest("no-re-exports", {
    valid: [
      'import { LIST } from "./list.ts"; const index = 0; export const FIRST = LIST[index];',
      `import * as ns from "./ns.ts"; const key = "run"; export default ns[\`\${key}\`];`,
      'import * as ns from "./ns.ts"; export const { run } = ns;',
      'import { LIST } from "./list.ts"; export const [FIRST] = LIST;',
      ...[
        "ns[+1n]",
        "ns[0]",
        "ns[1]",
        "ns[99999999999999999999]",
        "ns[ 1e21 ]",
        "ns[0x10]",
        "ns[1n]",
        "ns[-1]",
        "ns[+1]",
        "ns[-1n]",
      ].map((member) => `import * as ns from "./ns.ts"; export default ${member};`),
    ],
    invalid: [
      {
        code: 'import { LIST } from "./list.ts"; export const FIRST = LIST["0"];',
        errors: [{ message: initializedToMember("FIRST", 'LIST["0"]', "LIST", "./list.ts") }],
      },
      {
        code: 'import { config } from "./config.ts"; export const VALUE = config["a-b"];',
        errors: [
          { message: initializedToMember("VALUE", 'config["a-b"]', "config", "./config.ts") },
        ],
      },
      {
        code: 'import { config } from "./config.ts"; export default config[`a-b`];',
        errors: [{ message: reExportMember("default", "config[`a-b`]", "config", "./config.ts") }],
      },
      {
        code: 'import { config } from "./config.ts"; export default config["a\\"b"];',
        errors: [
          {
            message: reExportMember("default", String.raw`config["a\"b"]`, "config", "./config.ts"),
          },
        ],
      },
      ...['ns["99999999999999999999"]', "ns.café"].map((member) => ({
        code: `import * as ns from "./ns.ts"; export default ${member};`,
        errors: [{ message: reExportMember("default", member, "ns", "./ns.ts") }],
      })),
      {
        code: 'import * as ns from "./ns.ts"; export default ns // the member\n  .run;',
        errors: [
          {
            message: reExportMember(
              "default",
              String.raw`ns // the member\n  .run`,
              "ns",
              "./ns.ts",
            ),
          },
        ],
      },
      ...[
        ["ns\n.run", String.raw`ns\n.run`],
        ["ns // x\n.run", String.raw`ns // x\n.run`],
        ['ns["a  b"]', 'ns["a  b"]'],
        ['ns[\n  "run"\n]', String.raw`ns[\n  "run"\n]`],
        ["ns \r\n\t.run", "ns \\n\t.run"],
        ["ns\r.run", String.raw`ns\n.run`],
        ["ns /* a */\n  .run", String.raw`ns /* a */\n  .run`],
      ].map(([member = "", printed = ""]) => ({
        code: `import * as ns from "./ns.ts"; export default ${member};`,
        errors: [{ message: reExportMember("default", printed, "ns", "./ns.ts") }],
      })),
      {
        code: 'import { run } from "./run.ts"; export { run as "a-b" };',
        errors: [{ message: reExport('"a-b"', "run", "./run.ts") }],
      },
    ],
  }),
);

export const theFormatConfigFileMayExportTheImportedFormatConfig = Task.make(
  "no-re-exports lets oxfmt.config.ts export default the imported FORMAT_CONFIG, since the format-config check requires exactly that, while a default export there of any other import, even one renamed to FORMAT_CONFIG, and export default FORMAT_CONFIG in any other file, are still reported",
  ruleTest("no-re-exports", {
    valid: [
      {
        code: 'import { FORMAT_CONFIG } from "@sshkeda/check"; export default FORMAT_CONFIG;',
        filename: "oxfmt.config.ts",
      },
    ],
    invalid: [
      {
        code: 'import { FORMAT_CONFIG } from "@sshkeda/check"; export default FORMAT_CONFIG;',
        filename: "src/oxfmt.ts",
        errors: [{ message: reExport("default", "FORMAT_CONFIG", "@sshkeda/check") }],
      },
      {
        code: 'import { lintConfig as FORMAT_CONFIG } from "@sshkeda/check"; export default FORMAT_CONFIG;',
        filename: "oxfmt.config.ts",
        errors: [{ message: reExport("default", "FORMAT_CONFIG", "@sshkeda/check") }],
      },
      {
        code: 'import FORMAT_CONFIG from "./config.ts"; export default FORMAT_CONFIG;',
        filename: "oxfmt.config.ts",
        errors: [{ message: reExport("default", "FORMAT_CONFIG", "./config.ts") }],
      },
      {
        code: 'import { lintConfig } from "@sshkeda/check"; export default lintConfig;',
        filename: "oxfmt.config.ts",
        errors: [{ message: reExport("default", "lintConfig", "@sshkeda/check") }],
      },
      {
        code: 'import { FORMAT_CONFIG } from "@sshkeda/check"; export { FORMAT_CONFIG };',
        filename: "oxfmt.config.ts",
        errors: [{ message: reExport("FORMAT_CONFIG", "FORMAT_CONFIG", "@sshkeda/check") }],
      },
    ],
  }),
);

export const anIndexMayExportAChildModuleNamespace = Task.make(
  "an index may namespace the index of a module in its own lib/ exposing only its own unrenamed internal exports, while a sibling index or a module nested deeper may not",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    yield* writtenFiles(directory, {
      "package.json": '{"name":"namespace-sample"}',
      "src/index.ts": "",
      "src/lib/task/index.ts": 'export { make, run } from "./internal/task.ts";',
      "src/lib/task/internal/task.ts": "export const make = () => 1; export const run = () => 2;",
      "src/lib/renamed/index.ts": 'export { make as create } from "./internal/task.ts";',
      "src/lib/renamed/internal/task.ts": "export const make = () => 1;",
      "src/lib/everything/index.ts": 'export * from "./internal/task.ts";',
      "src/lib/everything/internal/task.ts": "export const make = () => 1;",
      "src/lib/logic/index.ts": "export const make = () => 1;",
      "src/sibling/index.ts": 'export { make } from "./internal/task.ts";',
      "src/sibling/internal/task.ts": "export const make = () => 1;",
      "src/lib/task/lib/deeper/index.ts": 'export { make } from "./internal/task.ts";',
      "src/lib/task/lib/deeper/internal/task.ts": "export const make = () => 1;",
    });
    const filename = path.join(directory, "src/index.ts");
    yield* reExportsCheckTest({
      valid: [{ filename, code: 'export * as Task from "./lib/task/index.ts";' }],
      invalid: [
        "./lib/task/internal/task.ts",
        "./lib/renamed/index.ts",
        "./lib/everything/index.ts",
        "./lib/logic/index.ts",
        "./sibling/index.ts",
        "./lib/task/lib/deeper/index.ts",
      ].map((source) => ({
        filename,
        code: `export * as Task from "${source}";`,
        errors: [{ message: `export * from ${source} re-exports another module` }],
      })),
    });
    yield* ruleTest("no-re-exports", {
      valid: [],
      invalid: [
        {
          filename,
          code: 'export * from "./lib/task/index.ts";',
          errors: [{ message: "export * from ./lib/task/index.ts re-exports another module" }],
        },
      ],
    });
  }).pipe(Effect.scoped),
);

export const theReExportsCheckJudgesEveryIndexOfTheProject = Task.make(
  "the re-exports check judges the export from and export * as of every index file the project checks, reads each file without blocking, and names each refused export by its file and line, while non-index files are left to no-re-exports",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, {
      "src/m/index.ts":
        'export { run } from "./internal/a.ts";\nexport { run as start } from "./a.ts";\n',
      "src/m/internal/a.ts": RUN,
      "src/m/a.ts": RUN,
      "src/n/index.ts":
        'export { run as start } from "./internal/a.ts";\nexport * as M from "../m/index.ts";\n',
      "src/n/internal/a.ts": RUN,
      "src/other.ts": 'export { run } from "./m/a.ts";\n',
    });
    const refused = yield* findIndexReExportViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("IndexReExportsRefused", ({ violations }) =>
        Effect.succeed(violations.map(({ location, judgment }) => `${location} ${judgment}`)),
      ),
    );
    expect(refused).toEqual([
      `src/m/index.ts:2 export from ./a.ts re-exports ${OUTSIDE_LAYOUT}`,
      "src/n/index.ts:1 export from ./internal/a.ts renames run to start",
      "src/n/index.ts:2 export * from ../m/index.ts re-exports another module",
    ]);
  }).pipe(Effect.scoped),
);

export const theReExportsCheckSkipsGeneratedIndexes = Task.make(
  "the re-exports check skips an index file granted isGeneratedByATool, as the lint rules do, and still judges the other index files",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      {
        "src/index.ts": 'export { run } from "./generated.ts";\n',
        "src/generated.ts": RUN,
        "src/m/index.ts": 'export { run } from "./a.ts";\n',
        "src/m/a.ts": RUN,
      },
      'lintConfig({ "src/index.ts": { allow: [{ isGeneratedByATool: "generated entry" }] } })',
    );
    const refused = yield* findIndexReExportViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("IndexReExportsRefused", ({ violations }) =>
        Effect.succeed(violations.map(({ location, judgment }) => `${location} ${judgment}`)),
      ),
    );
    expect(refused).toEqual([`src/m/index.ts:1 export from ./a.ts re-exports ${OUTSIDE_LAYOUT}`]);
  }).pipe(Effect.scoped),
);
