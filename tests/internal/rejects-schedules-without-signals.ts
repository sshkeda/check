import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const ALLOWED_WITH_DEADLINE = [{ timedSchedules: "allowedWithDeadline" }] as const;

export const rejectsEveryScheduleUsage = Task.make(
  "no-schedules rejects every timed Schedule usage and scheduled retries outside files allowed pollsWithADeadline, and allows a count-only Schedule.recurs(n)",
  ruleTest("no-schedules", {
    valid: [
      'import { Effect } from "effect"; Effect.retry(work, { times: 3 });',
      'import { Schedule } from "effect"; Schedule.recurs(3);',
      'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.recurs(3));',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.recurs(3)));',
      'import { recurs } from "effect/Schedule"; recurs(3);',
      'import { Schedule } from "effect"; Schedule.recurs(3).pipe(Schedule.map((count) => count + 1));',
      'import { Schedule } from "effect"; Schedule.map(Schedule.recurs(3), (count) => count + 1);',
      'import { pipe, Schedule } from "effect"; pipe(Schedule.recurs(3), Schedule.map((count) => count + 1));',
      'import { Schedule } from "effect"; Schedule.recurs(3).pipe(Schedule.map(String), Schedule.map(Number));',
      'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.map(Schedule.recurs(3), String));',
      'import { Schedule } from "other"; Schedule.spaced("1 second");',
      'import { Effect } from "effect"; function make(Schedule) { return Schedule.spaced("1 second"); }',
      'import type { Schedule } from "effect"; type Policy = Schedule.Schedule<number>;',
      "const Schedule = { spaced: () => 1 }; Schedule.spaced();",
    ],
    invalid: [
      ...[
        'import { Schedule } from "effect"; Schedule.spaced("1 second");',
        'import { Schedule } from "effect"; Schedule.fixed("1 second");',
        'import { Schedule } from "effect"; Schedule.exponential("10 millis");',
        'import { Schedule } from "effect"; const forever = Schedule.recurs;',
        'import { Schedule } from "effect"; Schedule.recurs(3).pipe(Schedule.addDelay(() => "1 second"));',
        'import { Schedule } from "effect"; Schedule.recurs(3).pipe(Schedule.map(String), Schedule.addDelay(() => "1 second"));',
        'import { pipe, Schedule } from "effect"; pipe(Schedule.recurs(3), Schedule.map(String), Schedule.addDelay(() => "1 second"));',
        'import * as Schedule from "effect/Schedule"; Schedule.forever;',
        'import { spaced } from "effect/Schedule"; spaced("1 second");',
        'import { Schedule as Policy } from "effect"; Policy.spaced("1 second");',
        'import * as Library from "effect"; Library.Schedule.spaced("1 second");',
        'import { Schedule } from "effect"; const { spaced } = Schedule;',
        'import { Effect } from "effect"; work.pipe(Effect.repeat(($) => $.spaced("1 second")));',
      ].map((code) => ({ code, errors: [{ messageId: "polling" }] })),
      ...[
        'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.recurs(3).pipe(Schedule.addDelay(() => "1 second")));',
      ].map((code) => ({ code, errors: [{ messageId: "retrying" }] })),
      {
        code: 'import { pipe, Schedule } from "effect"; pipe(Schedule.recurs(3), Schedule.addDelay(() => "1 second"), Schedule.map(String));',
        errors: [{ messageId: "polling" }, { messageId: "polling" }],
      },
      {
        code: 'import { Schedule } from "effect"; Schedule.spaced("1 second").pipe(Schedule.map(String));',
        errors: [{ messageId: "polling" }, { messageId: "polling" }],
      },
    ],
  }),
);

export const requiresDeadlinesInScheduleFiles = Task.make(
  "no-schedules in files allowed pollsWithADeadline accepts only repeating with Schedule.spaced when a timeout bounds it",
  ruleTest("no-schedules", {
    valid: [
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat({ until, schedule: Schedule.spaced("50 millis") }), Effect.timeout("10 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.timeout(Effect.repeat(work, Schedule.spaced("1 second")), "30 seconds");',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.spaced("1 second"))).pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: recover }));',
      'import { Effect, Schedule, pipe } from "effect"; pipe(work, Effect.repeat(Schedule.spaced("1 second")), Effect.timeoutOption("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.gen(function* () { yield* work.pipe(Effect.repeat(Schedule.spaced("1 second"))); }).pipe(Effect.timeout("1 minute"));',
    ].map((code) => ({ code, options: ALLOWED_WITH_DEADLINE })),
    invalid: [
      ...[
        'import { Schedule } from "effect"; const policy = Schedule.spaced("1 second");',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.spaced("1 second")));',
      ].map((code) => ({
        code,
        options: ALLOWED_WITH_DEADLINE,
        errors: [{ messageId: "deadline" }],
      })),
      ...[
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry({ times: 30, schedule: Schedule.spaced("1 second") }), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; Effect.timeout(Effect.retry(work, Schedule.spaced("1 second")), "30 seconds");',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry({ times: 30, schedule: Schedule.spaced("1 second") }));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeout("30 seconds"), Effect.retry(Schedule.spaced("1 second")));',
        'import { Effect } from "effect"; work.pipe(Effect.retry(($) => $.spaced("1 second")), Effect.timeout("30 seconds"));',
      ].map((code) => ({
        code,
        options: ALLOWED_WITH_DEADLINE,
        errors: [{ messageId: "retryingEvenWhenGranted" }],
      })),
      ...[
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.exponential("1 second")), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.fixed("1 second")), Effect.timeout("30 seconds"));',
        'import { Effect } from "effect"; work.pipe(Effect.repeat(($) => $.spaced("1 second")), Effect.timeout("30 seconds"));',
      ].map((code) => ({
        code,
        options: ALLOWED_WITH_DEADLINE,
        errors: [{ messageId: "scheduleEvenWhenGranted" }],
      })),
    ],
  }),
);
