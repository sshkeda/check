import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Array as Arrays, flow } from "effect";

import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const MISUSES = [
  'import { createRequire } from "node:module";',
  'import { fileURLToPath } from "node:url";',
  'import path from "node:path";',
  "const base = import.meta.url;",
  "export const file = fileURLToPath(import.meta.url);",
  "export const load = createRequire(import.meta.url);",
  "export const computed = (name: string) => new URL(name, import.meta.url);",
  'export const nested = new URL("./worker.ts", new URL("..", import.meta.url));',
  'export const onDirectory = new URL("./worker.ts", import.meta.dir);',
  `export const printed = \`\${import.meta.url}\`;`,
  `export const templated = \`\${import.meta.dir}/worker.ts\`;`,
  'export const added = import.meta.dirname + "/worker.ts";',
  "export const joined = path.dirname(fileURLToPath(import.meta.url));",
  "export const kept = { base };",
  "",
].join("\n");

const INLINE_USES = [
  'import { fileURLToPath } from "node:url";',
  'export const worker = new URL("./worker.ts", import.meta.url);',
  "export const templated = new URL(`./worker.ts`, import.meta.url);",
  'export const directory = fileURLToPath(new URL("..", import.meta.url));',
  'export const started = new Worker(new URL("./worker.ts", import.meta.url).href);',
  'export const api = new URL("/api", "https://example.com");',
  'export const relative = (page: URL) => new URL("./next", page);',
  'export const here = [import.meta.path, import.meta.dir, import.meta.resolve("./worker.ts")];',
  "",
].join("\n");

const violationsIn = (sources: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "package.json": '{ "name": "urls", "type": "module" }\n',
      "src/worker.ts": "export const WORKER = 1;\n",
      ...sources,
    });
    return yield* findImportBoundaryViolations(tsconfigFile).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("ImportBoundariesCrossed", (failure) =>
        Effect.succeed(taggedViolations(failure.violations).toSorted()),
      ),
    );
  });

export const moduleUrlsAreWrittenInline = Task.make(
  'production code may use import.meta.url only as the base of new URL("literal", import.meta.url), and may not build module paths from import.meta.dir or import.meta.dirname, while tests and test helpers may do anything',
  Effect.gen(function* () {
    expect(
      yield* violationsIn({
        "src/misuses.ts": MISUSES,
        "scripts/build.ts": MISUSES,
        "tests/misuses.ts": MISUSES,
        "tests/shared/misuses.ts": MISUSES,
      }),
    ).toEqual(
      ["src/misuses.ts", "scripts/build.ts"]
        .flatMap((file) => [
          `${file}:4: error ModuleUrlNotInline: stores import.meta.url in a variable`,
          `${file}:5: error ModuleUrlPassedToFunction: passes import.meta.url to fileURLToPath`,
          `${file}:6: error ModuleUrlPassedToFunction: passes import.meta.url to createRequire`,
          `${file}:7: error ModuleUrlNotInline: builds a module URL from a computed path`,
          `${file}:8: error ModuleUrlNotInline: builds a module URL on a base other than import.meta.url itself`,
          `${file}:9: error ModuleUrlNotInline: builds a module URL on a base other than import.meta.url itself`,
          `${file}:10: error ModuleUrlNotInline: uses import.meta.url outside new URL("…", import.meta.url)`,
          `${file}:11: error ModulePathFromDirectory: builds a module path from import.meta.dir`,
          `${file}:12: error ModulePathFromDirectory: builds a module path from import.meta.dirname`,
          `${file}:13: error ModuleUrlPassedToFunction: passes import.meta.url to fileURLToPath`,
        ])
        .toSorted(),
    );
    expect(yield* violationsIn({ "src/inline.ts": INLINE_USES })).toEqual([]);
  }).pipe(Effect.scoped),
);
