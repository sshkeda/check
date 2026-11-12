import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { findUnobservedForkFailures } from "../../src/lib/tasks/lib/refuse-forks-whose-failures-nothing-observes/internal/find-unobserved-fork-failures.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const FAILING = `import { Context, Effect, Fiber, FiberHandle, FiberMap, FiberSet, pipe, Schema } from "effect";
class LineUnreadable extends Schema.TaggedError<LineUnreadable>()("LineUnreadable", {}) {}
const failing = Effect.fail(new LineUnreadable());
`;

const inGenerator = (body: string) =>
  `${FAILING}export const program = Effect.gen(function* () {\n${body}\n});\n`;

const violationsOf = (sources: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(sources);
    return yield* findUnobservedForkFailures(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as(
        new Array<{
          readonly location: string;
          readonly fork: string;
          readonly failures: readonly string[];
        }>(),
      ),
      Effect.catchTag("UnobservedForkFailuresRefused", ({ violations }) =>
        Effect.succeed(
          violations.map(({ location, fork, failures }) => ({
            location: location.replace(/:\d+$/u, ""),
            fork,
            failures,
          })),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const failingWith = (location: string, fork: string, failures: readonly string[]) => ({
  location,
  fork,
  failures,
});

const lost = (location: string, fork: string) => failingWith(location, fork, ["LineUnreadable"]);

export const droppedForksAreRefused = Task.make({
  name: "a fork thrown away where it is made, of an effect that can still fail, is refused for each fork operation, data-first, data-last, as a statement, after void, as the last step of a thrown-away pipe or before Effect.asVoid or Effect.as, through a runForkWith alias, curried and called at once, of a Data.TaggedError alone or in a union, or with the failures a catchTag leaves",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts": `${FAILING}Effect.runFork(failing);\n`,
        "b.ts": `${FAILING}export const start = (services: Context.Context<never>) => {\n  const fork = Effect.runForkWith(services);\n  fork(failing);\n  Effect.runForkWith(services)(failing);\n};\n`,
        "c.ts": inGenerator(
          "  yield* Effect.forkChild(failing);\n  yield* failing.pipe(Effect.forkChild({ startImmediately: true }));",
        ),
        "d.ts": inGenerator(
          "  yield* failing.pipe(Effect.forkScoped);\n  yield* Effect.forkScoped(failing);",
        ),
        "e.ts": inGenerator(
          "  const scope = yield* Effect.scope;\n  yield* Effect.forkIn(failing, scope);\n  yield* failing.pipe(Effect.forkIn(scope));",
        ),
        "f.ts": inGenerator(
          "  yield* Effect.forkDetach(failing);\n  void (yield* Effect.forkDetach(failing));",
        ),
        "g.ts": inGenerator(
          '  yield* failing.pipe(Effect.forkScoped, Effect.asVoid);\n  yield* Effect.forkChild(failing).pipe(Effect.asVoid);\n  yield* failing.pipe(Effect.forkChild, Effect.as("started"));',
        ),
        "h.ts": `${FAILING}process.once("SIGTERM", () => {\n  Effect.runFork(failing);\n});\nvoid Effect.runFork(failing);\n`,
        "i.ts": `${FAILING}class LineMissing extends Schema.TaggedError<LineMissing>()("LineMissing", {}) {}\nEffect.runFork(Effect.fail(new LineMissing()).pipe(Effect.andThen(failing), Effect.catchTag("LineUnreadable", Effect.logError)));\n`,
        "j.ts": `${FAILING}failing.pipe(Effect.runFork);\npipe(failing, Effect.runFork);\n`,
        "k.ts": inGenerator(
          '  yield* pipe(Effect.forkChild(Effect.fail("x")), Effect.asVoid);\n  yield* Effect.fail("x").pipe(Effect.forkChild, Effect.asVoid, Effect.andThen(Effect.void));',
        ),
        "l.ts": inGenerator('  yield* Effect.forkChild({})(Effect.fail("x"));'),
        "m.ts": `${FAILING}import { Data } from "effect";\nclass LineMissing extends Data.TaggedError("LineMissing") {}\nclass LineLate extends Data.TaggedError("LineLate") {}\nEffect.runFork(Effect.fail(new LineMissing()));\nEffect.runFork(Effect.fail(new LineMissing()).pipe(Effect.andThen(Effect.fail(new LineLate()))));\n`,
      }),
    ).toEqual([
      lost("a.ts:4", "Effect.runFork"),
      lost("b.ts:6", "Effect.runForkWith"),
      lost("b.ts:7", "Effect.runForkWith"),
      lost("c.ts:5", "Effect.forkChild"),
      lost("c.ts:6", "Effect.forkChild"),
      lost("d.ts:5", "Effect.forkScoped"),
      lost("d.ts:6", "Effect.forkScoped"),
      lost("e.ts:6", "Effect.forkIn"),
      lost("e.ts:7", "Effect.forkIn"),
      lost("f.ts:5", "Effect.forkDetach"),
      lost("f.ts:6", "Effect.forkDetach"),
      lost("g.ts:5", "Effect.forkScoped"),
      lost("g.ts:6", "Effect.forkChild"),
      lost("g.ts:7", "Effect.forkChild"),
      lost("h.ts:5", "Effect.runFork"),
      lost("h.ts:7", "Effect.runFork"),
      failingWith("i.ts:5", "Effect.runFork", ["LineMissing"]),
      lost("j.ts:4", "Effect.runFork"),
      lost("j.ts:5", "Effect.runFork"),
      failingWith("k.ts:5", "Effect.forkChild", ["string"]),
      failingWith("k.ts:6", "Effect.forkChild", ["string"]),
      failingWith("l.ts:5", "Effect.forkChild", ["string"]),
      failingWith("m.ts:7", "Effect.runFork", ["LineMissing"]),
      failingWith("m.ts:8", "Effect.runFork", ["LineLate", "LineMissing"]),
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const tappedFailuresAreRefused = Task.make({
  name: "a dropped fork whose effect logs or taps its failure with tapCause, tapError, onExit or onError is refused because the effect can still fail, inside Effect.all or before a later step that fails included",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts": `${FAILING}Effect.runFork(failing.pipe(Effect.onExit(() => Effect.void)));\nEffect.runFork(failing.pipe(Effect.tapCause(Effect.logError)));\nEffect.runFork(failing.pipe(Effect.tapError(Effect.logError)));\nEffect.runFork(failing.pipe(Effect.onError(() => Effect.void)));\n`,
        "b.ts": inGenerator(
          '  yield* Effect.forkChild(Effect.all([Effect.fail("x").pipe(Effect.tapCause(Effect.logError))]));',
        ),
        "c.ts": `${FAILING}Effect.runFork(failing.pipe(Effect.tapCause(Effect.logError), Effect.andThen(Effect.fail("later"))));\n`,
      }),
    ).toEqual([
      lost("a.ts:4", "Effect.runFork"),
      lost("a.ts:5", "Effect.runFork"),
      lost("a.ts:6", "Effect.runFork"),
      lost("a.ts:7", "Effect.runFork"),
      failingWith("b.ts:5", "Effect.forkChild", ["string"]),
      failingWith("c.ts:4", "Effect.runFork", ["LineUnreadable", "string"]),
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const droppedExitsAreRefused = Task.make({
  name: "a dropped fork of Effect.exit, Effect.result or Effect.option is refused with the failure it hides, and one that is kept or handled passes",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts": `${FAILING}Effect.runFork(Effect.exit(failing));\nEffect.runFork(Effect.result(failing));\n`,
        "b.ts": inGenerator(
          "  yield* failing.pipe(Effect.exit, Effect.forkChild);\n  yield* failing.pipe(Effect.option, Effect.forkChild);\n  yield* Effect.option(failing).pipe(Effect.forkChild);",
        ),
        "c.ts": inGenerator(
          "  const fiber = yield* Effect.forkChild(Effect.exit(failing));\n  return yield* Fiber.join(fiber);",
        ),
        "d.ts": `${FAILING}Effect.runFork(Effect.exit(failing).pipe(Effect.flatMap(() => Effect.void)));\n`,
      }),
    ).toEqual([
      lost("a.ts:4", "Effect.runFork"),
      lost("a.ts:5", "Effect.runFork"),
      lost("b.ts:5", "Effect.forkChild"),
      lost("b.ts:6", "Effect.forkChild"),
      lost("b.ts:7", "Effect.forkChild"),
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const keptForksPass = Task.make({
  name: "a fork whose fiber is bound, joined, returned, passed on, given an observer or handed to a pipe step before it is discarded passes, as does any fork into a FiberSet, FiberMap or FiberHandle, a fork whose failure is handled to never, unknown, or at its top level a type parameter, this, a template literal or string mapping over one, a conditional, keyof or indexed access type, a tuple spreading one, or any intersection or mapped type, even a concrete one such as a Data.TaggedError used without a class, an unyielded fork effect, and any fork under tests",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts": inGenerator(
          "  const fiber = yield* Effect.forkChild(failing);\n  yield* Fiber.join(fiber);\n  const unread = Effect.runFork(failing);\n  yield* Effect.runFork(failing);",
        ),
        "b.ts": inGenerator("  return yield* failing.pipe(Effect.forkScoped);"),
        "c.ts": `${FAILING}export const start = () => Effect.runFork(failing);\nexport const keep = (fiber: Fiber.Fiber<never, LineUnreadable>) => fiber;\nexport const kept = () => keep(Effect.runFork(failing));\nconst observe = () => {};\nEffect.runFork(failing, { onFiberStart(fiber) { fiber.addObserver(observe); } });\n`,
        "d.ts": inGenerator(
          '  const set = yield* FiberSet.make();\n  yield* FiberSet.run(set, failing);\n  yield* failing.pipe(FiberSet.run(set));\n  const run = FiberSet.run(set);\n  const start = run;\n  yield* start(failing);\n  const map = yield* FiberMap.make<string>();\n  yield* FiberMap.run(map, "key", failing);\n  const handle = yield* FiberHandle.make();\n  yield* FiberHandle.run(handle, failing);\n  yield* set.pipe(FiberSet.size);',
        ),
        "e.ts": `${FAILING}class Owner {\n  constructor(readonly fibers: FiberSet.FiberSet) {}\n}\nconst waitFor = (fibers: FiberSet.FiberSet) => FiberSet.join(fibers);\nexport const program = Effect.gen(function* () {\n  const owner = { fibers: yield* FiberSet.make() };\n  yield* FiberSet.run(owner.fibers, failing);\n  yield* waitFor(owner.fibers);\n  const left = new Owner(yield* FiberSet.make());\n  const right = new Owner(yield* FiberSet.make());\n  yield* FiberSet.run(left.fibers, failing);\n  yield* FiberSet.join(right.fibers);\n});\n`,
        "f.ts": `${FAILING}Effect.runFork(failing.pipe(Effect.catchCause((cause) => Effect.logError(cause))));\nEffect.runFork(failing.pipe(Effect.tapCause(Effect.logError), Effect.andThen(Effect.fail("later")), Effect.catchCause((cause) => Effect.logError(cause))));\nexport const program = Effect.gen(function* () {\n  yield* Effect.forkChild(Effect.all([Effect.fail("x")]).pipe(Effect.catchCause((cause) => Effect.logError(cause))));\n  yield* failing.pipe(Effect.catchTag("LineUnreadable", Effect.logError), Effect.forkScoped);\n});\n`,
        "g.ts": `${FAILING}Effect.runFork(Effect.void);\nexport const program = Effect.gen(function* () {\n  yield* Effect.log("started").pipe(Effect.forkScoped);\n});\n`,
        "h.ts": `${FAILING}export const inBackground = <Failure>(effect: Effect.Effect<void, Failure>) => {\n  Effect.runFork(effect);\n};\nexport const anyFailure = (effect: Effect.Effect<void, unknown>) => {\n  Effect.runFork(effect);\n};\nexport const tagged = <F>(work: Effect.Effect<F, F & { readonly _tag: "Failure" }>) => {\n  Effect.runFork(work);\n};\nexport const spread = <F extends ReadonlyArray<unknown>>(work: Effect.Effect<void, readonly [LineUnreadable, ...F]>) => {\n  Effect.runFork(work);\n};\nexport const partial = <F>(work: Effect.Effect<void, Partial<F>>) => {\n  Effect.runFork(work);\n};\nexport const excluded = <F>(work: Effect.Effect<void, Exclude<F, string>>) => {\n  Effect.runFork(work);\n};\nexport const key = <F>(work: Effect.Effect<void, keyof F>) => {\n  Effect.runFork(work);\n};\nexport const indexed = <F, K extends keyof F>(work: Effect.Effect<void, F[K]>) => {\n  Effect.runFork(work);\n};\n`,
        "i.ts": inGenerator("  Effect.forkChild(failing);"),
        "j.ts": `${FAILING}export const labelled = <T extends string>(work: Effect.Effect<void, \`Failure:\${T}\`>) => {\n  Effect.runFork(work);\n};\n`,
        "k.ts": `${FAILING}export class Runner {\n  start(work: Effect.Effect<void, this>) {\n    Effect.runFork(work);\n  }\n}\n`,
        "l.ts": `${FAILING}export const upper = <T extends string>(work: Effect.Effect<void, Uppercase<T>>) => {\n  Effect.runFork(work);\n};\nexport const lower = <T extends string>(work: Effect.Effect<void, Lowercase<T>>) => {\n  Effect.runFork(work);\n};\nexport const capital = <T extends string>(work: Effect.Effect<void, Capitalize<T>>) => {\n  Effect.runFork(work);\n};\nexport const uncapital = <T extends string>(work: Effect.Effect<void, Uncapitalize<T>>) => {\n  Effect.runFork(work);\n};\n`,
        "m.ts": `${FAILING}import { Data } from "effect";\nconst Oops = Data.TaggedError("Oops");\nEffect.runFork(Effect.fail(new Oops()));\nexport const member = <F>(work: Effect.Effect<void, { readonly _tag: "Failure" } & { readonly details: { readonly value: F } }>) => {\n  Effect.runFork(work);\n};\nexport const fixed = (work: Effect.Effect<void, Readonly<{ readonly line: number }>>) => {\n  Effect.runFork(work);\n};\nexport const conflicting = <T extends string>(work: Effect.Effect<void, { readonly _tag: T } & { readonly _tag: "Wanted" }>) => {\n  Effect.runFork(work);\n};\nexport function background<E extends { code: unknown }>() {\n  type Failure<A> = { [K in keyof E]: E[K] | A };\n  return (work: Effect.Effect<void, Failure<string>>) => {\n    Effect.runFork(work);\n  };\n}\ntype Oops = Record<"_tag", "Oops">;\nexport const record = (work: Effect.Effect<void, Oops>) => {\n  Effect.runFork(work);\n};\n`,
        "n.ts": inGenerator(
          "  yield* Effect.forkChild(failing).pipe(Effect.flatMap(Fiber.join), Effect.asVoid);\n  yield* failing.pipe(Effect.forkChild, Effect.tap(Fiber.join), Effect.asVoid);",
        ),
        "tests/a.ts": `${FAILING}Effect.runFork(failing);\n`,
      }),
    ).toEqual([]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const failuresHoldingTypeParametersAreRefused = Task.make({
  name: "a dropped fork whose failure only holds a type parameter inside it, in an array or a tuple beside this, is refused, as is an empty tuple, a Data.TaggedError class given its fields type,each concrete member of a union beside a type parameter or this, a template literal or string mapping over string, and a failure type that grows each time it is instantiated",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts": `${FAILING}export const nested = <F>(work: Effect.Effect<void, LineUnreadable | ReadonlyArray<F>>) => {\n  Effect.runFork(work);\n};\nexport const deep = <F>(work: Effect.Effect<void, ReadonlyArray<ReadonlyArray<ReadonlyArray<ReadonlyArray<ReadonlyArray<F>>>>>>) => {\n  Effect.runFork(work);\n};\nexport const mixed = <F>(work: Effect.Effect<void, LineUnreadable | F>) => {\n  Effect.runFork(work);\n};\nexport const pattern = (work: Effect.Effect<void, \`x\${string}\`>) => {\n  Effect.runFork(work);\n};\nexport const upper = (work: Effect.Effect<void, Uppercase<string>>) => {\n  Effect.runFork(work);\n};\n`,
        "b.ts": `${FAILING}export class Runner {\n  first(work: Effect.Effect<void, readonly [Runner, this]>) {\n    Effect.runFork(work);\n  }\n  last(work: Effect.Effect<void, readonly [this, Runner]>) {\n    Effect.runFork(work);\n  }\n  either(work: Effect.Effect<void, Runner | this>) {\n    Effect.runFork(work);\n  }\n}\n`,
        "c.ts": `${FAILING}interface Failure<T> {\n  readonly next: Failure<T[]>;\n}\nexport const start = (work: Effect.Effect<void, Failure<string>>) => {\n  Effect.runFork(work);\n};\n`,
        "d.ts": `${FAILING}import { Data } from "effect";\nclass Oops extends Data.TaggedError("Oops")<{}> {}\nexport const empty = (work: Effect.Effect<void, readonly []>) => {\n  Effect.runFork(work);\n};\nexport const frozen = (work: Effect.Effect<void, Readonly<[]>>) => {\n  Effect.runFork(work);\n};\nEffect.runFork(Effect.fail(new Oops()));\n`,
      }),
    ).toEqual([
      failingWith("a.ts:5", "Effect.runFork", ["LineUnreadable", "readonly F[]"]),
      failingWith("a.ts:8", "Effect.runFork", [
        "readonly (readonly (readonly (readonly (readonly F[])[])[])[])[]",
      ]),
      failingWith("a.ts:11", "Effect.runFork", ["LineUnreadable"]),
      failingWith("a.ts:14", "Effect.runFork", [`\`x\${string}\``]),
      failingWith("a.ts:17", "Effect.runFork", ["Uppercase<string>"]),
      failingWith("b.ts:6", "Effect.runFork", ["readonly [Runner, this]"]),
      failingWith("b.ts:9", "Effect.runFork", ["readonly [this, Runner]"]),
      failingWith("b.ts:12", "Effect.runFork", ["Runner"]),
      failingWith("c.ts:8", "Effect.runFork", ["Failure<string>"]),
      failingWith("d.ts:7", "Effect.runFork", ["readonly []"]),
      failingWith("d.ts:10", "Effect.runFork", ["readonly []"]),
      failingWith("d.ts:12", "Effect.runFork", ["Oops"]),
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const remainingFailuresAreNamed = Task.make({
  name: "the report names the fork and every failure type the forked effect can still fail with, with the fix",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "a.ts": `${FAILING}class LineMissing extends Schema.TaggedError<LineMissing>()("LineMissing", {}) {}\nexport const read = () => {\n  Effect.runFork(Effect.fail(new LineMissing()).pipe(Effect.andThen(failing)));\n};\n`,
    });
    const messages = yield* findUnobservedForkFailures(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("UnobservedForkFailuresRefused", ({ violations }) =>
        Effect.succeed(violations.map(({ location, message }) => `${location}: ${message}`)),
      ),
    );
    expect(messages).toEqual([
      "a.ts:6:3: Effect.runFork forks an effect that can still fail with LineMissing or LineUnreadable, and its fiber is dropped where it is made.",
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});
