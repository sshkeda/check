import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const OPERATION_VALID = [
  'import { Effect } from "effect"; Effect.catchTag("Failure", recover);',
  'import { Effect } from "other"; Effect.orDie(work);',
  'import { Effect } from "effect"; function test(Effect) { Effect.ignore(work); }',
  'import { orDie } from "other";',
  'import { Effect } from "effect"; Effect.timeout(work, "1 second");',
  'import { Effect } from "effect"; const run = Effect.fn("run")(function* () {});',
] as const;

const operationTest = (rule: string, invalid: readonly string[]) =>
  ruleTest(rule, {
    valid: OPERATION_VALID,
    invalid: invalid.map((code) => ({ code, errors: [{ messageId: "operation" }] })),
  });

export const unsafeOperations = Task.make(
  "Effect failure, fiber, tracing and sleeping restrictions are separate rules that follow imports and respect shadowing",
  Effect.all(
    [
      operationTest("no-dropped-failures", [
        'import { Effect } from "effect"; Effect.orDie(work);',
        'import { Effect } from "effect"; Effect["orDie"](work);',
        'import * as Effect from "effect/Effect"; work.pipe(Effect.orDie);',
        'import { orDie as crash } from "effect/Effect";',
        'import { Effect as Effects } from "effect"; Effects.orDieWith(work, fail);',
      ]),
      operationTest("no-detached-fibers", [
        'import * as Library from "effect"; Library.Effect.forkDetach(work);',
      ]),
      operationTest("no-sleep", [
        'import { Effect } from "effect"; Effect.sleep("1 second");',
        'import { Effect } from "effect"; work.pipe(Effect.delay("1 second"));',
        'import { delay as wait } from "effect/Effect";',
      ]),
      operationTest("no-untraced-functions", [
        'import { Effect } from "effect"; const run = Effect.fnUntraced(function* () {});',
      ]),
    ],
    { discard: true },
  ),
);

export const taggedRecovery = Task.make(
  "Effect recovery callbacks use tagged errors instead of instanceof",
  ruleTest("no-error-instanceof", {
    valid: [
      'import { Effect } from "effect"; Effect.catchTag("Failure", failure => recover(failure));',
      'import { Effect } from "effect"; Effect.catch(failure => other instanceof Other);',
      'import { Effect } from "effect"; Effect.catch(failure => { function nested(failure) { return failure instanceof Error; } return nested; });',
      'import { Effect } from "other"; Effect.catch(failure => failure instanceof Error);',
      'import { Effect } from "effect"; Effect.catch(failure => { { const failure = other; return failure instanceof Other; } });',
      'import { Effect } from "effect"; Effect.tryPromise({ try: run, catch: failure => failure instanceof Error });',
    ],
    invalid: [
      ...[
        'import { Effect } from "effect"; Effect.catch(failure => failure instanceof Error);',
        'import { Effect as Effects } from "effect"; Effects.catchIf(failure => failure instanceof Failure, recover);',
        'import * as Effect from "effect/Effect"; Effect.mapError(failure => failure instanceof Failure ? first : second);',
        'import { mapError } from "effect/Effect"; mapError(failure => failure instanceof Failure);',
      ].map((code) => ({ code, errors: [{ messageId: "tagged" }] })),
      {
        code: 'import { Effect } from "effect"; Effect.catchTag("Failure", failure => failure.cause instanceof Error);',
        errors: [
          {
            message: "instanceof tests a value reached from the parameter of Effect.catchTag",
          },
        ],
      },
    ],
  }),
);
