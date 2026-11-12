import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { TEST_TIMEOUTS_RULE } from "../../src/shared/record-and-grant-permissions-by-path.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const testsBoundOnlyByTheirTask = Task.make({
  name: "no-test-timeouts refuses every Effect timeout and timed Schedule however they are imported, and leaves count-bounded retries, TestClock and AbortSignal.timeout, which no-clock-reads-and-sleeps refuses in every file, alone",
  run: ruleTest(TEST_TIMEOUTS_RULE, {
    valid: [
      'import { Effect } from "effect"; Effect.retry(work, { times: 3 });',
      'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.recurs(3));',
      'import { Effect } from "effect"; Effect.repeat(work, { until: (done) => done });',
      'import { Effect } from "effect"; import { TestClock } from "effect/testing"; Effect.gen(function* () { yield* TestClock.adjust("1 minute"); });',
      'import { Effect } from "other"; Effect.timeout(work, "1 second");',
      'import { Effect } from "effect"; Effect.timed(work);',
      "AbortSignal.timeout(1000);",
      "new AbortController().signal;",
    ],
    invalid: [
      ...[
        'import { Effect } from "effect"; Effect.timeout(work, "1 second");',
        'import { Effect } from "effect"; work.pipe(Effect.timeoutOption("1 second"));',
        'import { Effect } from "effect"; Effect.timeoutOrElse(work, { duration: "1 second", orElse: recover });',
        'import * as Effect from "effect/Effect"; Effect.timeout(work, "1 second");',
        'import { timeout } from "effect/Effect"; timeout(work, "1 second");',
        'import { Effect as Effectful } from "effect"; Effectful.timeout(work, "1 second");',
      ].map((code) => ({ code, errors: [{ messageId: "timeout" }] })),
      ...[
        'import { Schedule } from "effect"; Schedule.spaced("1 second");',
        'import { Effect, Schedule } from "effect"; Effect.repeat(work, Schedule.fixed("1 second"));',
      ].map((code) => ({ code, errors: [{ messageId: "polling" }] })),
    ],
  }),
});
