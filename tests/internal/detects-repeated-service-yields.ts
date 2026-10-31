import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";

import { findRepeatedServiceYields } from "../../src/lib/tasks/lib/detect-repeated-service-yields/internal/find-repeated-service-yields.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const SERVICES = `import { Context, Effect } from "effect";
export class WorkerPool extends Context.Service<WorkerPool, { readonly run: Effect.Effect<void> }>()("WorkerPool") {}
export class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()("Clock") {}
`;

const typedProject = (sources: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.symlink(path.resolve("node_modules"), path.join(directory, "node_modules"));
    yield* fileSystem.writeFileString(
      path.join(directory, "tsconfig.json"),
      yield* encodeJson({
        compilerOptions: {
          strict: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["*.ts"],
      }),
    );
    yield* fileSystem.writeFileString(path.join(directory, "services.ts"), SERVICES);
    for (const [name, text] of Object.entries(sources)) {
      yield* fileSystem.writeFileString(path.join(directory, name), text);
    }
    return path.join(directory, "tsconfig.json");
  });

const violations = (sources: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const project = yield* typedProject(sources);
    return yield* findRepeatedServiceYields(project, openTypeScriptProjects(project)).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("RepeatedServiceYields", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
  }).pipe(Effect.scoped);

export const importedServices = Task.make(
  "imported services yielded twice through renamed and namespace imports are reported",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "imported.ts": `import { Effect } from "effect";
import { WorkerPool as Pool } from "./services.ts";
import * as Services from "./services.ts";
export const program = Effect.gen(function* () {
  const first = yield* Pool;
  const clock = yield* Services.Clock;
  const second = yield* Services.WorkerPool;
  return [first, second, clock];
});
`,
      }),
    ).toEqual([
      "imported.ts:7:18: error RepeatedServiceYield: service WorkerPool was already yielded at 5:17",
    ]);
  }),
);

export const builtInServices = Task.make(
  "built-in services yielded twice are reported",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "built-in.ts": `import { Effect, FileSystem, Path } from "effect";
import { FileSystem as Files } from "effect/FileSystem";
export const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* Files;
  return [fileSystem, path, files];
});
`,
      }),
    ).toEqual([
      "built-in.ts:6:17: error RepeatedServiceYield: service FileSystem was already yielded at 4:22",
    ]);
  }),
);

export const separateScopes = Task.make(
  "services in nested generators and repeated non-service yieldables pass",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "nested.ts": `import { Effect } from "effect";
import { WorkerPool } from "./services.ts";
const work = Effect.succeed(1);
export const program = Effect.gen(function* () {
  const pool = yield* WorkerPool;
  const first = yield* work;
  const second = yield* work;
  const nested = yield* Effect.gen(function* () {
    return yield* WorkerPool;
  });
  return [pool, nested, first, second];
});
`,
      }),
    ).toEqual([]);
  }),
);

export const cleanProject = Task.make(
  "clean projects pass the typed service yield check",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "clean.ts": `import { Effect } from "effect";
import { Clock, WorkerPool } from "./services.ts";
export const program = Effect.gen(function* () {
  const pool = yield* WorkerPool;
  const clock = yield* Clock;
  return [pool, clock];
});
`,
      }),
    ).toEqual([]);
  }),
);
