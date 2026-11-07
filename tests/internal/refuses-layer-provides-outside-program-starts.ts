import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";

import { findLayerProvidesOutsideProgramStarts } from "../../src/lib/tasks/lib/confine-layer-provides-to-program-starts/internal/find-layer-provides-outside-program-starts.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { writtenFiles } from "../shared/checked-project.ts";

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const SERVICES = `import { Context, Effect, Layer } from "effect";
export class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()("Clock") {}
export const clockServices = Layer.succeed(Clock)({ now: Effect.succeed(0) });
export const clockServicesFor = (start: number) => Layer.succeed(Clock)({ now: Effect.succeed(start) });
export const buildClockServices = (start: number) => Layer.build(clockServicesFor(start));
export const work = Effect.flatMap(Clock.asEffect(), (clock) => clock.now);
export const builtClockServices = Layer.build(clockServices);
export const buildInGenerator = () => Effect.gen(function* () { return yield* Layer.build(clockServices); });
`;

const LAYER_OUTSIDE_START =
  "error LayerProvidedOutsideProgramStart: Effect.provide with a layer outside the call that starts the program";

const BUILT_CONTEXT_OUTSIDE_START =
  "error LayerProvidedOutsideProgramStart: Effect.provideContext with a context built from a layer outside the call that starts the program";

const BUILT_PROVIDED_OUTSIDE_START =
  "error LayerProvidedOutsideProgramStart: Effect.provide with a context built from a layer outside the call that starts the program";

const EFFECT_DECLARATIONS_DIRECTORY = "dist";

const violations = (
  sources: Readonly<Record<string, string>>,
  customConditions: readonly string[] = [],
  directoriesAboveProject: readonly string[] = [],
  effectDeclarationsDirectory = EFFECT_DECLARATIONS_DIRECTORY,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const directory = path.join(root, ...directoriesAboveProject);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.makeDirectory(path.join(directory, "node_modules"));
    for (const dependency of ["@effect", "@standard-schema"]) {
      yield* fileSystem.symlink(
        path.resolve("node_modules", dependency),
        path.join(directory, "node_modules", dependency),
      );
    }
    const isEffectRelaid = effectDeclarationsDirectory !== EFFECT_DECLARATIONS_DIRECTORY;
    if (isEffectRelaid) {
      const relaidEffect = path.join(directory, "node_modules/effect");
      yield* fileSystem.makeDirectory(
        path.dirname(path.join(relaidEffect, effectDeclarationsDirectory)),
        {
          recursive: true,
        },
      );
      yield* fileSystem.symlink(
        path.resolve("node_modules/effect", EFFECT_DECLARATIONS_DIRECTORY),
        path.join(relaidEffect, effectDeclarationsDirectory),
      );
      const manifest = yield* fileSystem.readFileString(
        path.resolve("node_modules/effect/package.json"),
      );
      yield* fileSystem.writeFileString(
        path.join(relaidEffect, "package.json"),
        manifest.replaceAll(
          `./${EFFECT_DECLARATIONS_DIRECTORY}/`,
          `./${effectDeclarationsDirectory}/`,
        ),
      );
    } else {
      yield* fileSystem.symlink(
        path.resolve("node_modules/effect"),
        path.join(directory, "node_modules/effect"),
      );
    }
    if (!Object.keys(sources).some((file) => file.startsWith("node_modules/@sshkeda/task/"))) {
      yield* fileSystem.makeDirectory(path.join(directory, "node_modules/@sshkeda"), {
        recursive: true,
      });
      yield* fileSystem.symlink(
        path.resolve("node_modules/@sshkeda/task"),
        path.join(directory, "node_modules/@sshkeda/task"),
      );
    }
    yield* writtenFiles(directory, {
      "tsconfig.json": yield* encodeJson({
        compilerOptions: {
          strict: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          customConditions,
          preserveSymlinks: isEffectRelaid,
        },
        include: ["src", "scripts"],
      }),
      "src/services.ts": SERVICES,
      ...sources,
    });
    const project = path.join(directory, "tsconfig.json");
    return yield* findLayerProvidesOutsideProgramStarts(
      project,
      openTypeScriptProjects(project),
    ).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("LayerProvidesOutsideProgramStarts", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
  }).pipe(Effect.scoped);

export const aProjectInsideTheTaskPackageDirectoryKeepsItsOwnRunOutsideTheRunners = Task.make(
  "a project that lives at node_modules/@sshkeda/task does not make its own run function the task runner",
  Effect.gen(function* () {
    expect(
      yield* violations(
        {
          "src/main.ts": `import { Effect } from "effect";
import { clockServices, work } from "./services.ts";
export const run = (program: Effect.Effect<number>) => program;
run(work.pipe(Effect.provide(clockServices)));
`,
        },
        [],
        ["node_modules", "@sshkeda", "task"],
      ),
    ).toEqual([`src/main.ts:4:15: ${LAYER_OUTSIDE_START}`]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const programStarts = Task.make(
  "layers provided inside runMain, runFork, other runners or a const only a runner runs pass",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "src/main.ts": `import { runMain as start } from "@effect/platform-bun/BunRuntime";
import { BunRuntime } from "@effect/platform-bun";
import { Effect, ManagedRuntime, Runtime } from "effect";
import { clockServices, work } from "./services.ts";
BunRuntime.runMain(work.pipe(Effect.provide(clockServices)));
start(Effect.gen(function* () { return yield* work.pipe(Effect.provide(clockServices)); }));
Effect.runFork(work.pipe(Effect.provide(clockServices)));
Effect.runPromiseWith(Effect.context<never>())(Effect.provide(work, [clockServices]));
const program = work.pipe(Effect.provide(clockServices));
BunRuntime.runMain(program);
const runMain = Runtime.makeRunMain(({ fiber }) => fiber);
runMain(work.pipe(Effect.provide(clockServices)));
ManagedRuntime.make(clockServices).runPromise(work.pipe(Effect.provide(clockServices)));
const run = Effect.runSync;
run(work.pipe(Effect.provide(clockServices)));
const wrapped = work.pipe(Effect.provide(clockServices));
Effect.runPromise((wrapped satisfies typeof work));
`,
      }),
    ).toEqual([]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const relaidEffectStarts = Task.make(
  "runners and provides keep their meaning when Effect declares them at other paths inside its package",
  Effect.gen(function* () {
    expect(
      yield* violations(
        {
          "src/main.ts": `import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Runtime } from "effect";
import { provide as supply } from "effect/Effect";
import { clockServices, work } from "./services.ts";
BunRuntime.runMain(work.pipe(Effect.provide(clockServices)));
Effect.runPromiseWith(Effect.context<never>())(Effect.provide(work, [clockServices]));
const runMain = Runtime.makeRunMain(({ fiber }) => fiber);
runMain(work.pipe(supply(clockServices)));
ManagedRuntime.make(clockServices).runPromise(work.pipe(Effect.provide(clockServices)));
export const helper = work.pipe(Effect.provide(clockServices));
export const built = Effect.gen(function* () {
  return yield* Effect.provide(work, yield* Effect.scoped(Layer.build(clockServices)));
});
`,
        },
        [],
        [],
        "build/esm/types",
      ),
    ).toEqual([
      `src/main.ts:10:33: ${LAYER_OUTSIDE_START}`,
      `src/main.ts:12:17: ${BUILT_PROVIDED_OUTSIDE_START}`,
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const providesOutsideStarts = Task.make(
  "layers provided in a helper, an exported const, a const run twice or an array are reported",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "src/helpers.ts": `import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { provide as supply } from "effect/Effect";
import { clockServices, work } from "./services.ts";
export const helper = work.pipe(Effect.provide(clockServices));
export const exported = work.pipe(supply(clockServices));
BunRuntime.runMain(exported);
const twice = Effect.provide(work, clockServices);
BunRuntime.runMain(twice);
BunRuntime.runMain(twice);
export const both = (effect: typeof work) => Effect.provide(effect, [clockServices, clockServices]);
export const later = () => Effect.runPromise(work.pipe(Effect.provide(clockServices))).then(() => work.pipe(Effect.provide(clockServices)));
`,
      }),
    ).toEqual([
      `src/helpers.ts:5:33: ${LAYER_OUTSIDE_START}`,
      `src/helpers.ts:6:35: ${LAYER_OUTSIDE_START}`,
      `src/helpers.ts:8:15: ${LAYER_OUTSIDE_START}`,
      `src/helpers.ts:11:46: ${LAYER_OUTSIDE_START}`,
      `src/helpers.ts:12:109: ${LAYER_OUTSIDE_START}`,
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const streamProvidesOutsideStarts = Task.make(
  "layers provided to a Stream outside the call that starts the program are reported like Effect.provide, and one provided inside a runner's argument is not",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "src/streams.ts": `import { Effect, Stream } from "effect";
import { provide as supply } from "effect/Stream";
import { clockServices, work } from "./services.ts";
export const now = Stream.fromEffect(work).pipe(Stream.provide(clockServices));
export const supplied = Stream.fromEffect(work).pipe(supply(clockServices));
export const started = () => Effect.runPromise(Stream.runCollect(Stream.fromEffect(work).pipe(Stream.provide(clockServices))));
`,
      }),
    ).toEqual([
      "src/streams.ts:4:49: error LayerProvidedOutsideProgramStart: Stream.provide with a layer outside the call that starts the program",
      "src/streams.ts:5:54: error LayerProvidedOutsideProgramStart: Stream.provide with a layer outside the call that starts the program",
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const layersFromOtherFiles = Task.make(
  "a layer under a name with no layer suffix and a layer returned by a helper from another file are reported",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "src/imported.ts": `import { Effect } from "effect";
import { clockServices as services, clockServicesFor, work } from "./services.ts";
export const named = work.pipe(Effect.provide(services));
export const made = Effect.provide(work, clockServicesFor(3));
`,
      }),
    ).toEqual([
      `src/imported.ts:3:32: ${LAYER_OUTSIDE_START}`,
      `src/imported.ts:4:21: ${LAYER_OUTSIDE_START}`,
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const handBuiltContexts = Task.make(
  "contexts built from a layer by hand and provided outside the start are reported",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "src/built.ts": `import { Effect, Layer } from "effect";
import { buildClockServices, clockServices, work } from "./services.ts";
import * as Services from "./services.ts";
export const yielded = Effect.gen(function* () {
  const services = yield* Layer.build(clockServices);
  return yield* work.pipe(Effect.provideContext(services));
});
export const imported = Effect.gen(function* () {
  return yield* Effect.provideContext(work, yield* buildClockServices(1));
});
export const scoped = Effect.scopedWith((scope) =>
  Layer.buildWithScope(clockServices, scope).pipe(
    Effect.flatMap((services) => Effect.provideContext(work, services)),
  ),
);
export const namespaced = Effect.gen(function* () {
  return yield* Effect.provide(work, yield* Services.builtClockServices);
});
export const generated = Effect.gen(function* () {
  const services = yield* Services.buildInGenerator();
  return yield* Effect.provideContext(work, services);
});
export const scopedFirst = Effect.gen(function* () {
  const services = yield* Effect.scoped(Layer.build(clockServices));
  return yield* Effect.provideContext(work, services);
});
`,
        "src/cycle.ts": `import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { Clock, clockServices, work } from "./services.ts";
function first(count: number): Effect.Effect<Context.Context<Clock>, never, Scope.Scope> {
  return count > 0 ? second(count - 1) : Layer.build(clockServices);
}
function second(count: number): Effect.Effect<Context.Context<Clock>, never, Scope.Scope> {
  return first(count);
}
export const fromFirst = Effect.gen(function* () {
  return yield* Effect.provideContext(work, yield* first(1));
});
export const fromSecond = Effect.gen(function* () {
  return yield* Effect.provideContext(work, yield* second(1));
});
`,
      }),
    ).toEqual([
      `src/built.ts:6:27: ${BUILT_CONTEXT_OUTSIDE_START}`,
      `src/built.ts:9:17: ${BUILT_CONTEXT_OUTSIDE_START}`,
      `src/built.ts:13:34: ${BUILT_CONTEXT_OUTSIDE_START}`,
      `src/built.ts:17:17: ${BUILT_PROVIDED_OUTSIDE_START}`,
      `src/built.ts:21:17: ${BUILT_CONTEXT_OUTSIDE_START}`,
      `src/built.ts:25:17: ${BUILT_CONTEXT_OUTSIDE_START}`,
      `src/cycle.ts:11:17: ${BUILT_CONTEXT_OUTSIDE_START}`,
      `src/cycle.ts:14:17: ${BUILT_CONTEXT_OUTSIDE_START}`,
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const contextsAndSingleServices = Task.make(
  "single services, contexts not built from a layer and layers composed with layers pass",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "src/contexts.ts": `import { Context, Effect, Layer } from "effect";
import { Clock, clockServices, work } from "./services.ts";
const clockLive = Context.make(Clock, { now: Effect.succeed(1) });
export const single = work.pipe(Effect.provideService(Clock, { now: Effect.succeed(1) }));
export const made = work.pipe(Effect.provideContext(clockLive));
export const inherited = Effect.gen(function* () {
  const services = yield* Effect.context<Clock>();
  return yield* work.pipe(Effect.provide(services));
});
export const composed = clockServices.pipe(Layer.provide(clockServices));
const plain = Context.empty();
export const recovery = Layer.build(Layer.effectContext(Effect.fail(plain))).pipe(
  Effect.catch((failure) => Effect.provideContext(Effect.void, failure)),
);
`,
      }),
    ).toEqual([]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

const TASK_SCRIPT = `import { Task } from "@sshkeda/task";
import { Task as Tasks } from "@sshkeda/task";
import { Effect } from "effect";
import { clockServices, work } from "../src/services.ts";
const main = Task.make("main", work);
Task.main(main.pipe(Effect.provide(clockServices)));
const provided = Task.make("provided", work.pipe(Effect.provide(clockServices)));
Tasks.main(provided);
export const helper = work.pipe(Effect.provide(clockServices));
`;

export const taskRuns = Task.make(
  "layers provided inside the argument of @sshkeda/task's Task.main, or a const only Task.main runs, pass, and a helper is still reported, whether task resolves to its declarations or its source",
  Effect.gen(function* () {
    for (const customConditions of [[], ["@sshkeda/task-source"]]) {
      expect(yield* violations({ "scripts/main.ts": TASK_SCRIPT }, customConditions)).toEqual([
        `scripts/main.ts:9:33: ${LAYER_OUTSIDE_START}`,
      ]);
    }
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const taskBodiesStartPrograms = Task.make(
  "a layer provided in the body of a task made in src, which a script directly in scripts/ runs with Task.main, passes, since Task runs each task body as its own program, and a helper beside the task is still reported",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "src/tasks.ts": `import { Task } from "@sshkeda/task";
import { Effect } from "effect";
import { clockServices, work } from "./services.ts";
export const measure = Task.make("measure", work.pipe(Effect.provide(clockServices)));
export const helper = work.pipe(Effect.provide(clockServices));
`,
        "scripts/measure.ts": `import { Task } from "@sshkeda/task";
import { measure } from "../src/tasks.ts";
if (import.meta.main) {
  Task.main(measure);
}
`,
      }),
    ).toEqual([`src/tasks.ts:5:33: ${LAYER_OUTSIDE_START}`]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const testFilesStartPrograms = Task.make(
  "test files under tests count as program starts, since each test runs its own program",
  Effect.gen(function* () {
    expect(
      yield* violations({
        "tests/clock.ts": `import { Effect } from "effect";
import { clockServices, work } from "../src/services.ts";
export const clockTest = work.pipe(Effect.provide(clockServices));
`,
        "tests/shared/clock-services.ts": `import { Effect } from "effect";
import { clockServices, work } from "../../src/services.ts";
export const withClock = work.pipe(Effect.provide(clockServices));
`,
        "scripts/measure.ts": `import { Effect } from "effect";
import { clockServices, work } from "../src/services.ts";
export const measured = work.pipe(Effect.provide(clockServices));
`,
      }),
    ).toEqual([`scripts/measure.ts:3:35: ${LAYER_OUTSIDE_START}`]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const taskNamespaceRunsStartPrograms = Task.make(
  "Task.main starts programs through named imports and aliases from package source, declarations and a namespace re-export",
  Effect.gen(function* () {
    const shapes = {
      ts: {
        "index.ts":
          'import { Effect } from "effect"; export const Task = { main: (program: Effect.Effect<number>) => program };',
      },
      "d.ts": {
        "index.d.ts":
          'import { Effect } from "effect"; export declare const Task: { main: (program: Effect.Effect<number>) => void };',
      },
      namespace: {
        "index.ts": 'export * as Task from "./task/index.ts";',
        "task/index.ts": 'export { main } from "./internal/main.ts";',
        "task/internal/main.ts":
          'import { Effect } from "effect"; export const main = (program: Effect.Effect<number>) => program;',
      },
    };
    for (const [shape, files] of Object.entries(shapes)) {
      const entry = shape === "d.ts" ? "index.d.ts" : "index.ts";
      expect(
        yield* violations({
          "node_modules/@sshkeda/task/package.json": `{"name":"@sshkeda/task","exports":"./${entry}"}`,
          ...Object.fromEntries(
            Object.entries(files).map(([file, text]) => [
              `node_modules/@sshkeda/task/${file}`,
              text,
            ]),
          ),
          "scripts/main.ts": `import { Task } from "@sshkeda/task";
import { Task as T } from "@sshkeda/task";
import { Effect } from "effect";
import { work, clockServices } from "../src/services.ts";
Task.main(work.pipe(Effect.provide(clockServices)));
const provided = work.pipe(Effect.provide(clockServices));
T.main(provided);
export const helper = work.pipe(Effect.provide(clockServices));
`,
        }),
      ).toEqual([`scripts/main.ts:8:33: ${LAYER_OUTSIDE_START}`]);
    }
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);
