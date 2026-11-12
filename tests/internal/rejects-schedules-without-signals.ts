import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const ALLOWED_WITH_DEADLINE = [{ timedSchedules: "allowedWithDeadline" }] as const;

export const rejectsEveryScheduleUsage = Task.make({
  name: "no-schedules rejects every timed Schedule usage and scheduled retries outside files allowed pollsWithADeadline, and allows a count-only Schedule.recurs(n)",
  run: ruleTest("no-schedules", {
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
        'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.spaced("1 second")).pipe(Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.exponential("1 second")).pipe(Effect.timeout("30 seconds"));',
      ].map((code) => ({ code, errors: [{ messageId: "retrying" }] })),
      {
        code: 'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.exponential("1 second")), Effect.timeout("30 seconds"));',
        errors: [{ messageId: "polling", data: { usage: "Schedule.exponential" } }],
      },
      {
        code: 'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.exponential("1 second").pipe(Schedule.jittered)), Effect.timeout("30 seconds"));',
        errors: [
          { messageId: "retrying", data: { usage: "Schedule.exponential" } },
          { messageId: "retrying", data: { usage: "Schedule.jittered" } },
        ],
      },
      {
        code: 'import { pipe, Schedule } from "effect"; pipe(Schedule.recurs(3), Schedule.addDelay(() => "1 second"), Schedule.map(String));',
        errors: [{ messageId: "polling", data: { usage: "Schedule.addDelay" } }],
      },
      {
        code: 'import { Schedule } from "effect"; Schedule.spaced("1 second").pipe(Schedule.map(String));',
        errors: [{ messageId: "polling", data: { usage: "Schedule.spaced" } }],
      },
      {
        code: 'import { Effect, Schedule } from "effect"; const policy = Schedule.max([Schedule.identity(), Schedule.spaced("3 minutes")]).pipe(Schedule.setInputType(), Schedule.while(() => Effect.succeed(true)), Schedule.passthrough);',
        errors: [{ messageId: "polling", data: { usage: "Schedule.spaced" } }],
      },
      {
        code: 'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.identity().pipe(Schedule.passthrough)));',
        errors: [{ messageId: "polling", data: { usage: "Schedule.identity" } }],
      },
      {
        code: 'import { Schedule } from "effect"; const first = Schedule.spaced("1 second").pipe(Schedule.passthrough); const second = Schedule.identity();',
        errors: [
          { messageId: "polling", data: { usage: "Schedule.spaced" } },
          { messageId: "polling", data: { usage: "Schedule.identity" } },
        ],
      },
    ],
  }),
});

export const requiresDeadlinesInScheduleFiles = Task.make({
  name: "no-schedules in files allowed pollsWithADeadline accepts repeating or retrying with Schedule.spaced or a possibly jittered Schedule.exponential when a timeout bounds it",
  run: ruleTest("no-schedules", {
    valid: [
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat({ until, schedule: Schedule.spaced("50 millis") }), Effect.timeout("10 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.timeout(Effect.repeat(work, Schedule.spaced("1 second")), "30 seconds");',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.spaced("1 second"))).pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: recover }));',
      'import { Effect, Schedule, pipe } from "effect"; pipe(work, Effect.repeat(Schedule.spaced("1 second")), Effect.timeoutOption("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.gen(function* () { yield* work.pipe(Effect.repeat(Schedule.spaced("1 second"))); }).pipe(Effect.timeout("1 minute"));',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.spaced("1 second").pipe(Schedule.while(({ input }) => input.pending), Schedule.passthrough)), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.spaced("1 second")).pipe(Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry({ times: 30, schedule: Schedule.spaced("1 second") }), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.timeout(Effect.retry(work, Schedule.spaced("1 second")), "30 seconds");',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.retryOrElse(Schedule.spaced("1 second"), recover), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.retry(other, Schedule.spaced("1 second")).pipe(Effect.timeout("30 seconds")) });',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => other.pipe(Effect.retry(Schedule.spaced("1 second")), Effect.timeout("30 seconds")) }));',
      'import { Effect, Schedule } from "effect"; Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.timeout(Effect.repeat(other, Schedule.spaced("1 second")), "30 seconds") });',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => other.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.timeout("30 seconds")) }));',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.exponential("1 second")), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.timeout(Effect.retry(work, Schedule.exponential("1 second")), "30 seconds");',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry({ times: 30, schedule: Schedule.exponential("1 second") }), Effect.timeoutOption("30 seconds"));',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.exponential("1 second")), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.timeout(Effect.repeat(work, Schedule.exponential("1 second")), "30 seconds");',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat({ until, schedule: Schedule.exponential("1 second") }), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.jittered(Schedule.exponential("1 second"))).pipe(Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.exponential("1 second").pipe(Schedule.jittered)), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule, pipe } from "effect"; work.pipe(Effect.retry(pipe(Schedule.exponential("1 second"), Schedule.jittered)), Effect.timeout("30 seconds"));',
      'import { Effect, Function, Schedule } from "effect"; work.pipe(Effect.repeat(Function.pipe(Schedule.exponential("1 second"), Schedule.jittered)), Effect.timeout("30 seconds"));',
      'import { Effect, Function as Functions, Schedule } from "effect"; work.pipe(Effect.retry(Functions.pipe(Schedule.exponential("1 second"), Schedule.jittered)), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; import * as Functions from "effect/Function"; work.pipe(Effect.repeat(Functions.pipe(Schedule.exponential("1 second"), Schedule.jittered)), Effect.timeout("30 seconds"));',
      'import * as Library from "effect"; work.pipe(Library.Effect.retry(Library.Function.pipe(Library.Schedule.exponential("1 second"), Library.Schedule.jittered)), Library.Effect.timeout("30 seconds"));',
      'import { Effect, Schedule, pipe as through } from "effect"; work.pipe(Effect.repeat(through(Schedule.exponential("1 second"), Schedule.jittered)), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; import { pipe as through } from "effect/Function"; work.pipe(Effect.retry(through(Schedule.exponential("1 second"), Schedule.jittered)), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.jittered(Schedule.exponential("1 second").pipe(Schedule.jittered))), Effect.timeout("30 seconds"));',
      'import { Effect } from "effect"; import { exponential, jittered } from "effect/Schedule"; work.pipe(Effect.retry(exponential("1 second").pipe(jittered)), Effect.timeout("30 seconds"));',
      'import { Effect, Schedule } from "effect"; Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.retry(other, Schedule.exponential("1 second")).pipe(Effect.timeout("30 seconds")) });',
    ].map((code) => ({ code, options: ALLOWED_WITH_DEADLINE })),
    invalid: [
      ...[
        'import { Schedule } from "effect"; const policy = Schedule.spaced("1 second");',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.spaced("1 second")));',
        'import { Effect, Schedule } from "effect"; Effect.retry(work, Schedule.spaced("1 second"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry({ times: 30, schedule: Schedule.spaced("1 second") }));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeout("30 seconds"), Effect.retry(Schedule.spaced("1 second")));',
        'import { Effect, Schedule } from "effect"; Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.retry(other, Schedule.spaced("1 second")) });',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => other.pipe(Effect.retry(Schedule.spaced("1 second"))) }));',
        'import { Effect, Schedule } from "effect"; Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.repeat(other, Schedule.spaced("1 second")) });',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => other.pipe(Effect.repeat(Schedule.spaced("1 second"))) }));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.exponential("1 second")));',
        'import { Effect, Schedule } from "effect"; Effect.repeat(work, Schedule.exponential("1 second"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeout("30 seconds"), Effect.retry(Schedule.exponential("1 second")));',
        'import { Effect, Schedule } from "effect"; Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.retry(other, Schedule.exponential("1 second")) });',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => other.pipe(Effect.retry(Schedule.exponential("1 second"))) }));',
        'import { Effect, Schedule } from "effect"; Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.repeat(other, Schedule.exponential("1 second")) });',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => other.pipe(Effect.repeat(Schedule.exponential("1 second"))) }));',
      ].map((code) => ({
        code,
        options: ALLOWED_WITH_DEADLINE,
        errors: [{ messageId: "deadline" }],
      })),
      ...[
        'import { Effect } from "effect"; work.pipe(Effect.retry(($) => $.spaced("1 second")), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.fixed("1 second")), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.fibonacci("1 second")), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.cron("* * * * *")), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.windowed("1 second")), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.exponential("1 second").pipe(Schedule.addDelay(() => "1 second"))), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.repeat(Schedule.jittered(Schedule.spaced("1 second"))), Effect.timeout("30 seconds"));',
        'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.spaced("1 second").pipe(Schedule.jittered)), Effect.timeout("30 seconds"));',
        'import { Effect } from "effect"; work.pipe(Effect.repeat(($) => $.spaced("1 second")), Effect.timeout("30 seconds"));',
      ].map((code) => ({
        code,
        options: ALLOWED_WITH_DEADLINE,
        errors: [{ messageId: "scheduleEvenWhenGranted" }],
      })),
      {
        code: 'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.exponential("1 second").pipe(Schedule.jittered)));',
        options: ALLOWED_WITH_DEADLINE,
        errors: [
          { messageId: "deadline", data: { usage: "Schedule.exponential" } },
          { messageId: "deadline", data: { usage: "Schedule.jittered" } },
        ],
      },
      {
        code: 'import { Effect, Schedule } from "effect"; work.pipe(Effect.retry(Schedule.jittered(Schedule.fixed("1 second"))), Effect.timeout("30 seconds"));',
        options: ALLOWED_WITH_DEADLINE,
        errors: [
          { messageId: "scheduleEvenWhenGranted", data: { usage: "Schedule.jittered" } },
          { messageId: "scheduleEvenWhenGranted", data: { usage: "Schedule.fixed" } },
        ],
      },
    ],
  }),
});
