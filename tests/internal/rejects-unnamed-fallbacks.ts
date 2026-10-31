import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const fallback = (member: string) => ({
  message: `${member} is given a fallback for failures it does not name`,
});

export const namedRecoveriesTakeNoFallback = Task.make(
  "no-unnamed-fallbacks refuses the fallback argument of catchTag, catchTags, catchReason and catchReasons in Effect, Stream and Channel, data-first and data-last, spread or ambiguous, and leaves the named handlers alone, written inline or held in a local constant",
  ruleTest("no-unnamed-fallbacks", {
    valid: [
      'import { Effect } from "effect"; work.pipe(Effect.catchTag("Missing", () => Effect.void));',
      'import { Effect } from "effect"; Effect.catchTag(work, "Missing", () => Effect.void);',
      'import { Effect } from "effect"; work.pipe(Effect.catchTag(["Missing", "Other"], () => Effect.void));',
      'import { Effect } from "effect"; work.pipe(Effect.catchTags({ Missing: () => Effect.void }));',
      'import { Effect } from "effect"; Effect.catchTags(work, { Missing: () => Effect.void });',
      'import { Effect } from "effect"; work.pipe(Effect.catchReason("Failure", "Missing", () => Effect.void));',
      'import { Effect } from "effect"; Effect.catchReason(work, "Failure", "Missing", () => Effect.void);',
      'import { Effect } from "effect"; work.pipe(Effect.catchReasons("Failure", { Missing: () => Effect.void }));',
      'import { Effect } from "effect"; Effect.catchReasons(work, "Failure", { Missing: () => Effect.void });',
      'import { Stream } from "effect"; work.pipe(Stream.catchTag("Missing", () => Stream.empty));',
      'import { Effect } from "other"; Effect.catchTags(work, {}, () => Effect.void);',
      'import { Effect } from "effect"; const TAG = "Missing"; export const recover = (task) => Effect.catchTag(task, TAG, () => Effect.void);',
      'import { Effect } from "effect"; const handlers = { Missing: () => Effect.void }; export const recover = (task) => Effect.catchTags(task, handlers);',
      'import { Effect } from "effect"; const TAGS = ["Missing", "Other"] as const; const SHARED = TAGS; export const recover = (task) => Effect.catchTag(task, SHARED, () => Effect.void);',
      'import { Effect } from "effect"; const REASON = "Missing"; export const recover = (task) => Effect.catchReasons(task, "Failure", { [REASON]: () => Effect.void });',
    ],
    invalid: [
      {
        code: 'import { Effect } from "effect"; const handlers = { Missing: () => Effect.void }; export const recovered = Effect.catchTags(handlers, () => Effect.void);',
        errors: [fallback("Effect.catchTags")],
      },
      {
        code: 'import { Effect } from "effect"; const TAG = "Missing"; const named = () => Effect.void; export const recovered = Effect.catchTag(TAG, named, () => Effect.void);',
        errors: [fallback("Effect.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; let TAG = "Missing"; export const recover = (task) => Effect.catchTag(task, TAG, () => Effect.void);',
        errors: [fallback("Effect.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; const TAG = TAG; export const recover = (task) => Effect.catchTag(task, TAG, () => Effect.void);',
        errors: [fallback("Effect.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; export const recovered = Effect.catchTags(Effect.fail("failure"), {}, () => Effect.void);',
        errors: [fallback("Effect.catchTags")],
      },
      {
        code: 'import { Stream } from "effect"; export const recovered = Stream.catchTags(Stream.fail("failure"), {}, () => Stream.empty);',
        errors: [fallback("Stream.catchTags")],
      },
      {
        code: 'import { Effect } from "effect"; export const recover = (task) => Effect.catchTag(task, "Missing", () => Effect.void, () => Effect.void);',
        errors: [fallback("Effect.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.catchTag("Missing", () => Effect.void, () => Effect.void));',
        errors: [fallback("Effect.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.catchTags({ Missing: () => Effect.void }, () => Effect.void));',
        errors: [fallback("Effect.catchTags")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.catchReason("Failure", "Missing", () => Effect.void, () => Effect.void));',
        errors: [fallback("Effect.catchReason")],
      },
      {
        code: 'import { Effect } from "effect"; Effect.catchReason(work, "Failure", "Missing", () => Effect.void, () => Effect.void);',
        errors: [fallback("Effect.catchReason")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.catchReasons("Failure", { Missing: () => Effect.void }, () => Effect.void));',
        errors: [fallback("Effect.catchReasons")],
      },
      {
        code: 'import { Stream } from "effect"; work.pipe(Stream.catchReason("Failure", "Missing", () => Stream.empty, () => Stream.empty));',
        errors: [fallback("Stream.catchReason")],
      },
      {
        code: 'import { Channel } from "effect"; work.pipe(Channel.catchTag("Missing", () => Channel.empty, () => Channel.empty));',
        errors: [fallback("Channel.catchTag")],
      },
      {
        code: 'import { catchTag as recover } from "effect/Effect"; work.pipe(recover("Missing", () => Effect.void, () => Effect.void));',
        errors: [fallback("Effect.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.catchTag(TAG, handle, otherwise));',
        errors: [fallback("Effect.catchTag")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.catchTag(...handlers));',
        errors: [fallback("Effect.catchTag")],
      },
    ],
  }),
);
