import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const droppedFailuresOutsideEffect = Task.make(
  "no-dropped-failures reports dying in Layer, Stream and Channel and reading an Option or Result by throwing, and leaves recoveries, type-only imports and other modules to other rules",
  ruleTest("no-dropped-failures", {
    valid: [
      'import { Layer } from "effect"; const live = Layer.succeed(Service, value);',
      'import { Stream } from "effect"; work.pipe(Stream.catchTag("NotFound", () => Stream.empty));',
      'import { Option } from "effect"; Option.getOrElse(name, () => "");',
      'import { Stream } from "other"; work.pipe(Stream.orDie);',
      'import { Effect } from "effect"; work.pipe(Effect.catchTag("NotFound", recover));',
      'import { Stream } from "effect"; work.pipe(Stream.catchTags({ NotFound: () => Stream.empty }));',
      'import type { getOrThrow } from "effect/Option"; export const acceptsReader = (read: typeof getOrThrow) => read;',
      'import { type getOrThrow } from "effect/Option"; export const acceptsReader = (read: typeof getOrThrow) => read;',
      'import type { getOrThrowWith } from "effect/Result"; type Reader = typeof getOrThrowWith;',
    ],
    invalid: [
      {
        code: 'import { Layer } from "effect"; work.pipe((Layer as typeof Layer).orDie);',
        errors: [{ message: "Layer.orDie is banned" }],
      },
      {
        code: 'import { Stream } from "effect"; work.pipe((Stream satisfies object).orDie);',
        errors: [{ message: "Stream.orDie is banned" }],
      },
      {
        code: 'import { Layer } from "effect"; const live = Layer.effect(Service, make).pipe(Layer.orDie);',
        errors: [{ message: "Layer.orDie is banned" }],
      },
      {
        code: 'import { Stream } from "effect"; work.pipe(Stream.orDie);',
        errors: [{ message: "Stream.orDie is banned" }],
      },
      {
        code: 'import * as Stream from "effect/Stream"; work.pipe(Stream.orDie);',
        errors: [{ message: "Stream.orDie is banned" }],
      },
      {
        code: 'import { orDie } from "effect/Channel";',
        errors: [{ message: "Channel.orDie is banned" }],
      },
      {
        code: 'import { Option } from "effect"; const value = Option.getOrThrow(name);',
        errors: [{ message: "Option.getOrThrow is banned" }],
      },
      {
        code: 'import { Result } from "effect"; const value = Result.getOrThrowWith(parsed, (failure) => failure);',
        errors: [{ message: "Result.getOrThrowWith is banned" }],
      },
      {
        code: 'import { Option } from "effect"; const read = Option.getOrThrow; const value = read(name);',
        errors: [{ message: "Option.getOrThrow is banned" }],
      },
      {
        code: 'import { type getOrElse, getOrThrow } from "effect/Option";',
        errors: [{ message: "Option.getOrThrow is banned" }],
      },
      {
        code: 'import { UndefinedOr } from "effect"; const value = UndefinedOr.getOrThrow(name);',
        errors: [{ message: "UndefinedOr.getOrThrow is banned" }],
      },
      {
        code: 'import { getOrThrowWith } from "effect/UndefinedOr";',
        errors: [{ message: "UndefinedOr.getOrThrowWith is banned" }],
      },
    ],
  }),
);
