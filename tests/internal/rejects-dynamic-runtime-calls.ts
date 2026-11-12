import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const dynamicImports = Task.make({
  name: "dynamic imports are rejected while static imports pass, and a literal import() of a Node built-in Effect replaces is left to the rule that bans that module in every file",
  run: ruleTest("no-dynamic-import", {
    valid: [
      'import { Effect } from "effect";',
      'export { Effect } from "effect";',
      'const loaded = import("node:path");',
    ],
    invalid: [
      'const loaded = await import("effect");',
      "const load = (specifier) => import(specifier);",
    ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
  }),
});

export const allowsExplicitUntimedAtomicsWaits = Task.make({
  name: "Atomics waits with explicit undefined or Infinity timeouts pass, while finite and shadowed timeouts are rejected",
  run: ruleTest("no-clock-reads-and-sleeps", {
    valid: ["wait", "waitAsync"].flatMap((method) =>
      ["undefined", "Infinity"].map((timeout) => `Atomics.${method}(cells, 0, 0, ${timeout});`),
    ),
    invalid: [
      "Atomics.waitAsync(cells, 0, 0, 0);",
      "Atomics.waitAsync(cells, 0, 0, timeout);",
      "function wait(Infinity) { return Atomics.waitAsync(cells, 0, 0, Infinity); }",
      "function wait(undefined) { return Atomics.waitAsync(cells, 0, 0, undefined); }",
    ].map((code) => ({ code, errors: [{ messageId: "timedWait" }] })),
  }),
});

export const forgetsReassignedDateTimeFormatters = Task.make({
  name: "a reassigned formatter is not classified by its old Intl.DateTimeFormat initializer",
  run: ruleTest("no-clock-reads-and-sleeps", {
    valid: [
      'let formatter: Pick<Intl.DateTimeFormat, "format"> = new Intl.DateTimeFormat(); formatter = { format: () => "fixed" }; formatter.format();',
      'let formatter: Pick<Intl.DateTimeFormat, "formatToParts"> = Intl.DateTimeFormat(); formatter = { formatToParts: () => [] }; formatter.formatToParts();',
    ],
    invalid: [
      "let formatter = new Intl.DateTimeFormat(); formatter.format();",
      "const formatter = Intl.DateTimeFormat(); formatter.formatToParts();",
    ].map((code) => ({ code, errors: [{ messageId: "formatsNow" }] })),
  }),
});

export const clockPropertiesRespectTheirBindings = Task.make({
  name: "clock properties refer to global or imported runtime objects, while local objects and parameters pass",
  run: ruleTest("no-clock-reads-and-sleeps", {
    valid: [
      "function read(process) { return process.uptime(); }",
      "function read(Bun) { return Bun.nanoseconds(); }",
      'import process from "other"; process.uptime();',
      'import Bun from "other"; Bun.nanoseconds();',
      "const process = { uptime: () => 1 }; const { uptime } = process; uptime();",
      "function read(Temporal) { return Temporal.Now.instant(); }",
    ],
    invalid: [
      ["process.uptime();", "process.uptime"],
      ["const read = process.hrtime.bigint;", "process.hrtime"],
      ["const read = Bun.nanoseconds;", "Bun.nanoseconds"],
      ['import runtime from "node:process"; runtime.uptime();', "process.uptime"],
      ['import * as runtime from "bun"; runtime.nanoseconds();', "Bun.nanoseconds"],
      ["const { uptime } = process; uptime();", "process.uptime"],
      ["let read; ({ nanoseconds: read } = Bun);", "Bun.nanoseconds"],
      ["Temporal.Now.instant();", "Temporal.Now"],
      ["const { Now } = Temporal; Now.plainDateISO();", "Temporal.Now"],
    ].map(([code = "", usage = ""]) => ({
      code,
      errors: [{ messageId: "restrictedProperty", data: { usage } }],
    })),
  }),
});

export const clockReadsAndSleeps = Task.make({
  name: "the Date constructor, DateTime's unsafe clock reads, Intl.DateTimeFormat without a date, Atomics waits with a timeout and Effect timeouts on Effect.never are rejected, while shadowed names, given dates, untimed waits and timeouts on real work pass",
  run: ruleTest("no-clock-reads-and-sleeps", {
    valid: [
      "const Date = (value) => value; Date(1);",
      "function format(Date) { return Date(); }",
      "class Date {} const made = new Date();",
      "const parsed = new Date(1700000000000);",
      "Schema.Date;",
      'import { DateTime } from "effect"; DateTime.now;',
      'import { DateTime } from "other"; DateTime.nowUnsafe();',
      'new Intl.DateTimeFormat("en-US").format(given);',
      'const formatter = new Intl.DateTimeFormat("en-US"); formatter.formatToParts(given);',
      'new Intl.NumberFormat("en-US").format();',
      "Atomics.wait(cells, 0, 0);",
      "const Atomics = { wait: (...values) => values }; Atomics.wait(cells, 0, 0, 1000);",
      'import { Effect } from "effect"; work.pipe(Effect.timeoutOption("1 second"));',
      'import { Effect } from "effect"; Effect.timeout(work, "1 second");',
      'import { Effect } from "effect"; Effect.never.pipe(Effect.onInterrupt(cleanUp));',
      'import { Effect } from "effect"; Effect.never.pipe(Effect.raceFirst(work), Effect.timeoutOption("1 second"));',
      'import { Effect } from "effect"; Effect.never.pipe(Effect.raceFirst(work)).pipe(Effect.timeout("1 second"));',
    ],
    invalid: [
      ...["const now = Date();", "const text = globalDate(Date());"].map((code) => ({
        code,
        errors: [{ messageId: "dateCall" }],
      })),
      { code: "const now = new Date();", errors: [{ messageId: "currentDate" }] },
      ...[
        'import { DateTime } from "effect"; DateTime.nowUnsafe();',
        'import { nowUnsafe } from "effect/DateTime"; nowUnsafe();',
        'import * as DateTime from "effect/DateTime"; DateTime.isPastUnsafe(deadline);',
        'import { DateTime } from "effect"; const read = DateTime.isFutureUnsafe;',
      ].map((code) => ({ code, errors: [{ messageId: "clockRead" }] })),
      ...[
        'new Intl.DateTimeFormat("en-US").format();',
        "Intl.DateTimeFormat().formatToParts();",
        'const formatter = new Intl.DateTimeFormat("en-US"); formatter.format();',
      ].map((code) => ({ code, errors: [{ messageId: "formatsNow" }] })),
      ...[
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);",
        "Atomics.waitAsync(cells, 0, 0, 1000);",
      ].map((code) => ({ code, errors: [{ messageId: "timedWait" }] })),
      ...[
        'import { Effect } from "effect"; Effect.never.pipe(Effect.timeoutOption("1 second"), Effect.asVoid);',
        'import { Effect } from "effect"; Effect.timeout(Effect.never, "1 second");',
        'import { Effect, pipe } from "effect"; pipe(Effect.never, Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }));',
        'import { never, timeoutOption } from "effect/Effect"; never.pipe(timeoutOption("1 second"));',
        'import { Effect } from "effect"; Effect.never.pipe(Effect.onInterrupt(cleanUp)).pipe(Effect.timeoutOption("1 second"));',
        'import { Effect } from "effect"; Effect.never.pipe(Effect.onInterrupt(cleanUp), Effect.timeout("1 second"));',
      ].map((code) => ({ code, errors: [{ messageId: "neverTimeout" }] })),
    ],
  }),
});

export const cronStepsFromTheCurrentTime = Task.make({
  name: "Cron.next, Cron.prev and Cron.sequence without a start time are rejected, while given start times, spread arguments and other modules pass",
  run: ruleTest("no-clock-reads-and-sleeps", {
    valid: [
      'import { Cron } from "effect"; Cron.next(cron, start);',
      'import { prev } from "effect/Cron"; prev(cron, start);',
      'import { Cron } from "effect"; Cron.sequence(cron, start);',
      'import { Cron } from "effect"; Cron.next(...steps);',
      'import { Cron } from "other"; Cron.next(cron);',
    ],
    invalid: [
      ['import { Cron } from "effect"; Cron.next(cron);', "Cron.next"],
      ['import { prev } from "effect/Cron"; prev(cron);', "Cron.prev"],
      ['import { Cron } from "effect"; Cron.next(cron, undefined);', "Cron.next"],
      ['import * as Cron from "effect/Cron"; Cron.sequence(cron);', "Cron.sequence"],
    ].map(([code = "", usage = ""]) => ({
      code,
      errors: [{ messageId: "clockRead", data: { usage } }],
    })),
  }),
});

export const clockServiceSleeps = Task.make({
  name: "sleeping through the Clock service yielded from Clock.Clock or passed to clockWith is rejected, while its other members, other objects and reassigned bindings pass",
  run: ruleTest("no-clock-reads-and-sleeps", {
    valid: [
      'import { Clock, Effect } from "effect"; Effect.gen(function* () { const clock = yield* Clock.Clock; return clock.currentTimeMillis; });',
      'import { Effect } from "effect"; Effect.gen(function* () { const clock = yield* other; yield* clock.sleep("1 second"); });',
      'import { Effect } from "effect"; Effect.map(other, (clock) => clock.sleep("1 second"));',
      'import { Effect } from "effect"; Effect.map(other, ({ sleep }) => sleep("1 second"));',
      'import { Effect } from "effect"; Effect.clockWith(({ currentTimeMillis }) => currentTimeMillis);',
      'import { Clock, Effect } from "effect"; Effect.gen(function* () { let clock = yield* Clock.Clock; clock = other; yield* clock.sleep("1 second"); });',
      'import { Clock } from "other"; function* run() { const clock = yield* Clock.Clock; yield* clock.sleep("1 second"); }',
    ],
    invalid: [
      'import { Clock, Effect } from "effect"; Effect.gen(function* () { const clock = yield* Clock.Clock; yield* clock.sleep("1 second"); });',
      'import { Clock, Effect } from "effect"; Effect.gen(function* () { const { sleep } = yield* Clock.Clock; yield* sleep("1 second"); });',
      'import { Clock, Effect } from "effect"; Effect.gen(function* () { yield* (yield* Clock.Clock).sleep("1 second"); });',
      'import { Effect } from "effect"; Effect.clockWith((clock) => clock.sleep("1 second"));',
      'import * as Clock from "effect/Clock"; Clock.clockWith(function (clock) { return clock.sleep("1 second"); });',
      'import { Effect } from "effect"; Effect.clockWith(({ sleep }) => sleep("1 second"));',
      'import * as Clock from "effect/Clock"; Clock.clockWith(function ({ sleep: wait }) { return wait("1 second"); });',
    ].map((code) => ({
      code,
      errors: [{ messageId: "restrictedProperty", data: { usage: "Clock.sleep" } }],
    })),
  }),
});
