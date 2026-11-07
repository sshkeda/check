import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const EFFECT_IMPORT = 'import { Context, Effect, Layer, Schema, Stream } from "effect";';

const TAGGED_ERRORS = [
  'class Missing extends Schema.TaggedErrorClass<Missing>()("Missing", {}) {}',
  'class Refused extends Schema.TaggedErrorClass<Refused>()("Refused", {}) {}',
].join("\n");

const withEffect = (code: string) => `${EFFECT_IMPORT}\n${TAGGED_ERRORS}\n${code}`;

const plainError = (name: string) => ({ messageId: "plainError", data: { name } });

export const refusesGlobalErrorInFailureTypes = Task.make(
  "no-plain-error-failures rejects Effect, Stream and Layer types that fail with the global Error, and accepts tagged errors and never",
  ruleTest("no-plain-error-failures", {
    valid: [
      withEffect("export const read = (): Effect.Effect<string, Missing> => Effect.succeed('');"),
      withEffect(
        "export const read = (): Effect.Effect<string, Missing | Refused> => Effect.succeed('');",
      ),
      withEffect("export const read = (): Effect.Effect<string, never> => Effect.succeed('');"),
      withEffect("export const read = (): Effect.Effect<string> => Effect.succeed('');"),
      withEffect(
        "export class Backend extends Context.Service<Backend, { readonly create: (name: string) => Effect.Effect<void, Missing> }>()('Backend') {}",
      ),
      withEffect(
        "export const walk = (): Effect.Effect<void, Effect.Error<ReturnType<typeof load>>> => Effect.void;",
      ),
      withEffect(
        "export const stops = <Services, Error, Requirements>(layer: Layer.Layer<Services, Error, Requirements>) => layer;",
      ),
      'import { Effect } from "effect"; class Error extends Effect.Service {} export const read = (): Effect.Effect<void, Error> => Effect.void;',
      "export const read = (): Effect.Effect<void, Error> => Effect.void;",
      'import { Effect } from "./effect.ts"; export const read = (): Effect.Effect<void, Error> => Effect.void;',
      withEffect("export const errors: ReadonlyArray<Error> = [];"),
      withEffect("export const read = (): Effect.Effect<Error> => Effect.succeed(new Missing());"),
    ],
    invalid: [
      {
        code: withEffect(
          [
            "export class Backend extends Context.Service<Backend, {",
            "  readonly create: (name: string) => Effect.Effect<void, Error>;",
            "  readonly destroy: Effect.Effect<void, Error>;",
            "  remove(name: string): Effect.Effect<void, Error>;",
            "}>()('Backend') {}",
          ].join("\n"),
        ),
        errors: [plainError("create"), plainError("destroy"), plainError("remove")],
      },
      {
        code: withEffect(
          "export const describe = (name: string): Effect.Effect<string, Error> => Effect.fail(new Missing()).pipe(Effect.as(name));",
        ),
        errors: [plainError("describe")],
      },
      {
        code: withEffect(
          "export function describe(name: string): Effect.Effect<string, Error> { return Effect.succeed(name); }",
        ),
        errors: [plainError("describe")],
      },
      {
        code: withEffect(
          "export const read = (): Effect.Effect<string, Error | Missing> => Effect.succeed('');",
        ),
        errors: [plainError("read")],
      },
      {
        code: withEffect(
          "export const read = (): Effect.Effect<string, (Missing | Error)> => Effect.succeed('');",
        ),
        errors: [plainError("read")],
      },
      {
        code: withEffect(
          "export const read: Effect.Effect<string, globalThis.Error> = Effect.succeed('');",
        ),
        errors: [plainError("read")],
      },
      {
        code: withEffect("export const run = (effect: Effect.Effect<void, Error>) => effect;"),
        errors: [plainError("effect")],
      },
      {
        code: withEffect(
          "class Store { load(): Effect.Effect<void, Error> { return Effect.void; } }",
        ),
        errors: [plainError("load")],
      },
      {
        code: withEffect("export const lines: Stream.Stream<string, Error> = Stream.empty;"),
        errors: [plainError("lines")],
      },
      {
        code: withEffect("export const live: Layer.Layer<never, Error> = Layer.empty;"),
        errors: [plainError("live")],
      },
      {
        code: 'import * as Effect from "effect/Effect"; export const read = (): Effect.Effect<void, Error> => Effect.void;',
        errors: [plainError("read")],
      },
      {
        code: 'import type { Effect } from "effect/Effect"; export const read = (): Effect<void, Error> => undefined as never;',
        errors: [plainError("read")],
      },
      {
        code: withEffect("type Failing = Effect.Effect<void, Error>;"),
        errors: [plainError("Failing")],
      },
      {
        code: withEffect(
          'export const readLine = Effect.fn("readLine")(function* (line: string): Effect.fn.Return<string, Error> { return line; });',
        ),
        errors: [plainError("readLine")],
      },
      {
        code: withEffect(
          "export const read = Effect.gen(function* (): Effect.gen.Return<string, Error> { return ''; });",
        ),
        errors: [plainError("read")],
      },
      {
        code: 'import { Exit } from "effect"; export const read: Exit.Exit<string, Error> = Exit.succeed("");',
        errors: [plainError("read")],
      },
    ],
  }),
);
