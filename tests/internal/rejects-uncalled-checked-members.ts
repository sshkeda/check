import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const uncalled = (member: string) => ({
  message: `${member} is used as a value instead of being called where it is named`,
});

const STREAM = 'import { Stream } from "effect"; ';

export const checkedMembersAreCalledWhereNamed = Task.make(
  "no-uncalled-members reports a member whose ban is checked at its call, such as Stream.catchTag, Effect.retry, Stream.retry, Context.Service, Atomics.wait or Number.parseInt, wherever it is stored, passed, returned, exported, bound or wrapped, including by a TypeScript as, satisfies, non-null or instantiation expression, instead of called where it is named, and leaves calls, type positions, other members and lookalikes alone",
  ruleTest("no-uncalled-members", {
    valid: [
      `${STREAM}work.pipe(Stream.catchTag((error) => Stream.fail(error)));`,
      'import { catchTag } from "effect/Stream"; work.pipe(catchTag("Missing", (cause) => Stream.failCause(cause)));',
      'import * as Effects from "effect"; work.pipe(Effects.Stream.catchTag((error) => Effects.Stream.fail(error)));',
      'import { Effect } from "effect"; work.pipe(Effect.retry(policy), Effect.timeout("1 second"));',
      'import { Effect } from "effect"; const settled = Effect.all(works, { concurrency: 2 });',
      'import { Context } from "effect"; class Store extends Context.Service<Store>()("Store") {}',
      'import { Effect } from "effect"; const work = Effect.succeed(1); const map = Effect.map;',
      'import type { Stream } from "effect"; type Recover = typeof Stream.catchTag;',
      'import { Stream } from "other"; const recover = Stream.catchTag;',
      "const parsed = Number.parseInt(text, 16);",
      'const format = new Intl.DateTimeFormat("en");',
      "const Number = { parseInt: (text: string) => text }; const read = Number.parseInt;",
      "const isFinite = Number.isFinite;",
      'import { retry } from "effect/Effect"; type Retry = typeof retry; const policy: typeof retry | undefined = undefined;',
      'import { Effect } from "effect"; type Retry = typeof Effect.retry; export type { Retry };',
    ],
    invalid: [
      {
        code: `${STREAM}const recovery = { recover: Stream.catchTag }; export const recovered = Stream.fail("failure").pipe(recovery.recover(() => Stream.empty));`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}const again = Stream.retry;`,
        errors: [uncalled("Stream.retry")],
      },
      {
        code: `${STREAM}const identity = <Value>(value: Value) => value; const recover = identity(Stream.catchTag);`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}class Recovery extends Error { public static recover = Stream.catchTag; }`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}const recovery = { recover: Stream.catchTag }; export default recovery;`,
        errors: [uncalled("Stream.catchTag")],
      },
      { code: `${STREAM}const recover = Stream.catchTag;`, errors: [uncalled("Stream.catchTag")] },
      {
        code: `${STREAM}export const recover = Stream.catchTags;`,
        errors: [uncalled("Stream.catchTags")],
      },
      {
        code: `${STREAM}const run = () => Stream.catchTag;`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}Stream.catchTag.call(undefined, recover);`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}const bound = Stream.catchTag.bind(undefined);`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}const handlers = [Stream.catchTag];`,
        errors: [uncalled("Stream.catchTag")],
      },
      { code: `${STREAM}apply(...[Stream.catchTag]);`, errors: [uncalled("Stream.catchTag")] },
      {
        code: `${STREAM}const recover = flag ? Stream.catchTag : Stream.catchTags;`,
        errors: [uncalled("Stream.catchTag"), uncalled("Stream.catchTags")],
      },
      {
        code: `${STREAM}const recover = fallback ?? Stream.catchTag;`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}work.pipe((0, Stream.catchTag)(() => Stream.empty));`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: `${STREAM}work.pipe(Stream.catchTag!(() => Stream.empty));`,
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: 'import { catchTag } from "effect/Stream"; const recover = catchTag;',
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: 'import { catchTag } from "effect/Stream"; const handlers = { catchTag };',
        errors: [uncalled("Stream.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.mapError);',
        errors: [uncalled("Effect.mapError")],
      },
      {
        code: 'import { Effect } from "effect"; const collect = Effect.all; collect(works, { mode: "result" });',
        errors: [uncalled("Effect.all")],
      },
      {
        code: 'import { all } from "effect/Effect"; const collect = all satisfies typeof all;',
        errors: [uncalled("Effect.all")],
      },
      {
        code: 'import { Effect } from "effect"; const retry = Effect.retry;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { Effect } from "effect"; const timeouts = { limit: Effect.timeout };',
        errors: [uncalled("Effect.timeout")],
      },
      {
        code: 'import { Context } from "effect"; const make = Context.Service;',
        errors: [uncalled("Context.Service")],
      },
      {
        code: 'import { PlatformError } from "effect"; const make = PlatformError.systemError;',
        errors: [uncalled("PlatformError.systemError")],
      },
      { code: "const wait = Atomics.wait;", errors: [uncalled("Atomics.wait")] },
      { code: "const Format = Intl.DateTimeFormat;", errors: [uncalled("Intl.DateTimeFormat")] },
      {
        code: 'import { retry as again } from "effect/Effect"; const hidden = again satisfies typeof again;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { retry as again } from "effect/Effect"; const identity = <Value>(value: Value) => value; const hidden = identity(again satisfies typeof again);',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { retry } from "effect/Effect"; const hidden = retry as typeof retry;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { retry } from "effect/Effect"; const hidden = <typeof retry>retry;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { retry } from "effect/Effect"; const hidden = retry!;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { retry } from "effect/Effect"; const hidden = retry<never>;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { Effect } from "effect"; const hidden = Effect.retry satisfies typeof Effect.retry;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: 'import { retry } from "effect/Effect"; export default retry;',
        errors: [uncalled("Effect.retry")],
      },
      {
        code: "const numbers = texts.map(Number.parseInt);",
        errors: [uncalled("Number.parseInt")],
      },
    ],
  }),
);
