import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const IMPORTS = 'import { Effect, Stream } from "effect";\n';

const captured = (name: string, operation: string) => ({
  message: `${name} is written inside a function passed to ${operation}, which can run it concurrently or later; hold that state in a Ref`,
});

export const capturedWritesAreRefs = Task.make(
  "no-shared-holders reports a const object literal written inside a function passed to an Effect, Stream or Layer operation when the literal is declared outside that function, and leaves writes in plain functions, literals declared inside the callback, parameters, other values, globals and look-alike modules alone",
  ruleTest("no-shared-holders", {
    valid: [
      "const build = () => { const total = { count: 0 }; [1, 2].map((item) => { total.count += item; }); return total; };",
      `${IMPORTS}export const made = Effect.sync(() => { const total = { count: 0 }; total.count += 1; return total; });`,
      `${IMPORTS}export const run = (input: { count: number }) => Effect.sync(() => input.count);`,
      `${IMPORTS}export const exit = Effect.sync(() => { process.exitCode = 1; });`,
      `${IMPORTS}export const made = Effect.sync(() => { const write = (box: { count: number }) => { box.count = 1; }; return write; });`,
      "const Effect = { sync: (run: () => void) => run }; const state = { count: 0 }; Effect.sync(() => { state.count += 1; });",
      'import { Option } from "effect"; const state = { count: 0 }; Option.match(Option.none(), { onNone: () => { state.count = 1; }, onSome: () => {} });',
      `${IMPORTS}export const mark = (run: { done: boolean }) => Effect.sync(() => { run.done = true; });`,
      `${IMPORTS}export const mark = (runs: Map<string, { done: boolean }>) => Effect.gen(function* () { const run = runs.get("a"); yield* Effect.sync(() => { if (run) { run.done = true; } }); });`,
      `${IMPORTS}export const made = Effect.suspend(() => { const state = { count: 0 }; Effect.runSync(Effect.succeed((run: () => void) => run()))(() => { state.count++; }); return Effect.void; });`,
      `${IMPORTS}export const made = (input: { count: number }) => Effect.suspend(() => { const { state } = { state: input }; return Effect.sync(() => { state.count++; }); });`,
      `${IMPORTS}export const made = Effect.suspend(() => { const state = { count: 0 }; const step = () => { state.count++; }; return Effect.succeed(Effect.isEffect(step)); });`,
      `${IMPORTS}const keys = { name: "a" }; export const read = Effect.sync(() => { ({ [keys.name]: first } = source); });`,
      `${IMPORTS}const state = { count: 0 }; function increment() { state.count++; } increment();`,
      `${IMPORTS}function increment() { const state = { count: 0 }; state.count++; } Effect.sync(increment);`,
      `${IMPORTS}const state = { count: 0 }; function increment() { state.count++; } export const make = (increment: () => void) => Effect.sync(increment);`,
      `${IMPORTS}const state = { count: 0 }; function increment() { state.count++; } { const increment = () => 1; Effect.sync(increment); }`,
      `${IMPORTS}const state = { count: 0 }; function increment() { state.count++; } increment = () => 1; Effect.sync(increment);`,
    ],
    invalid: [
      ...[
        `${IMPORTS}const state = { count: 0 }; export const increment = Effect.mapEager(Effect.yieldNow, () => { state.count += 1; });`,
        `${IMPORTS}const state = { count: 0 }; export const increment = Effect.yieldNow.pipe(Effect.mapEager(() => { state.count += 1; }));`,
        `${IMPORTS}export const made = Effect.suspend(() => { const state = { count: 0 }; return Effect.mapEager(Effect.succeed(1), () => state.count++); });`,
        `${IMPORTS}export const make = Effect.suspend(() => { const state = { count: 0 }; function increment() { state.count++; } return Effect.mapEager(Effect.succeed(1), increment); });`,
      ].map((code) => ({ code, errors: [captured("state", "Effect.mapEager")] })),
      ...[
        `${IMPORTS}const state = { count: 0 }; function increment() { state.count++; } Effect.sync(increment);`,
        `${IMPORTS}const state = { count: 0 }; Effect.sync(increment); function increment() { state.count++; }`,
        `${IMPORTS}export const make = Effect.suspend(() => { const state = { count: 0 }; const step = Effect.sync(increment); function increment() { state.count++; } return step; });`,
        `${IMPORTS}const state = { count: 0 }; function increment(increment: number) { state.count += increment; } Effect.sync(increment);`,
      ].map((code) => ({ code, errors: [captured("state", "Effect.sync")] })),
      {
        code: `${IMPORTS}const state = { count: 0 }; function* increment() { state.count++; yield* Effect.void; } Effect.gen(increment);`,
        errors: [captured("state", "Effect.gen")],
      },
      {
        code: `${IMPORTS}const state = { count: 0 }; function increment() { state.count++; return Promise.resolve(); } Effect.tryPromise({ try: increment, catch: () => "failed" });`,
        errors: [captured("state", "Effect.tryPromise")],
      },
      {
        code: `${IMPORTS}export const make = Effect.gen(function* () { const state = { count: 0 }; const one = Effect.gen(function* () { state.count += yield* Effect.succeed(1); }); yield* Effect.all([one, one], { concurrency: 2 }); });`,
        errors: [captured("state", "Effect.gen")],
      },
      {
        code: `${IMPORTS}export const make = Effect.suspend(() => { const turn = { now: false }; return Effect.sync(() => { turn.now = true; }); });`,
        errors: [captured("turn", "Effect.sync")],
      },
      {
        code: `${IMPORTS}export const read = (stream: Stream.Stream<number>) => Effect.gen(function* () { const body = { size: 0 }; yield* stream.pipe(Stream.runForEach((chunk) => { [body.size] = [chunk]; return Effect.void; })); return body.size; });`,
        errors: [captured("body", "Stream.runForEach")],
      },
      {
        code: `${IMPORTS}export const make = Effect.suspend(() => { const cache: { last?: number } = { last: 1 }; return Effect.tryPromise({ try: () => fetch("a").then(() => { delete cache.last; }), catch: () => "failed" }); });`,
        errors: [captured("cache", "Effect.tryPromise")],
      },
      {
        code: `import * as Effect from "effect/Effect";\nconst watching = { id: 0 } satisfies { id: number };\nexport const watch = Effect.fn("watch")(function* (id: number) { (watching satisfies { id: number }).id = id; watching.id++; });`,
        errors: [captured("watching", "Effect.fn")],
      },
      {
        code: `${IMPORTS}export const make = Effect.suspend(() => { const state = { count: 0 }; const one = function* () { const seen = state.count; yield* Effect.yieldNow; state.count = seen + 1; }; const step = () => { state.count -= 1; }; return Effect.all([Effect.gen(one), Effect.sync(step)], { concurrency: 2 }); });`,
        errors: [captured("state", "Effect.gen")],
      },
      {
        code: `import { Context, Layer } from "effect";\nclass Counter extends Context.Service<Counter, { count: number }>()("Counter") {}\nexport const make = () => { const state = { count: 0 }; return Layer.sync(Counter)(() => { state.count++; return state; }); };`,
        errors: [captured("state", "Layer.sync")],
      },
    ],
  }),
);
