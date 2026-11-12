import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const IMPORTS = 'import { Clock, Effect, Schedule, Schema } from "effect";';

const granted = (...permissions: readonly string[]) => [{ permissions }];

const grantedInTheTestHome = (...permissions: readonly string[]) => [
  { permissions, testHome: "inside" },
];

const unused = (permission: string) => ({
  message: `this file is granted ${permission}, but uses nothing ${permission} allows`,
});

const inModule = (...declarations: readonly string[]) => [IMPORTS, ...declarations].join(" ");

const NOTHING_GRANTED = inModule("export const VALUE = 1;");

export const codeGrantsNothingUsesAreReported = Task.make({
  name: "no-unused-code-grants reports each granted handlesEveryFailure, waitsOnTimers, pollsWithADeadline, usesAbbreviations or trustsUnverifiedTypes once when no rule it lifts or relaxes would report anything in the file, counting only rules that run where the file sits",
  run: ruleTest("no-unused-code-grants", {
    valid: [
      NOTHING_GRANTED,
      {
        code: inModule("export const run = (work) => work.pipe(Effect.catch(() => Effect.void));"),
        options: granted("handlesEveryFailure"),
      },
      {
        code: inModule('export const run = (a, b) => Effect.all([a, b], { mode: "result" });'),
        options: granted("handlesEveryFailure"),
      },
      {
        code: inModule(
          'export const run = (work) => work.pipe(Effect.catchTag("Missing", Effect.fail, () => Effect.void));',
        ),
        options: granted("handlesEveryFailure"),
      },
      {
        code: inModule('export const paused = Effect.sleep("1 second");'),
        options: granted("waitsOnTimers"),
      },
      {
        code: inModule(
          'export const paused = Effect.gen(function* () { const clock = yield* Clock.Clock; yield* clock.sleep("1 second"); });',
        ),
        options: granted("waitsOnTimers"),
      },
      {
        code: inModule(
          'export const polled = (work) => work.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.timeout("1 minute"));',
        ),
        options: granted("pollsWithADeadline"),
      },
      {
        code: inModule('export const bounded = (work) => work.pipe(Effect.timeout("1 minute"));'),
        options: grantedInTheTestHome("pollsWithADeadline"),
      },
      {
        code: "export const args = [];",
        options: granted("usesAbbreviations"),
      },
      {
        code: inModule(
          'export const Port = Schema.declare((input): input is number => typeof input === "number");',
        ),
        options: granted("trustsUnverifiedTypes"),
      },
      {
        code: inModule('export const paused = Effect.sleep("1 second"); export const args = [];'),
        options: granted("waitsOnTimers", "usesAbbreviations"),
      },
    ],
    invalid: [
      {
        code: NOTHING_GRANTED,
        options: granted("handlesEveryFailure"),
        errors: [unused("handlesEveryFailure")],
      },
      {
        code: NOTHING_GRANTED,
        options: granted("handlesEveryFailure", "waitsOnTimers", "usesAbbreviations"),
        errors: [
          unused("handlesEveryFailure"),
          unused("waitsOnTimers"),
          unused("usesAbbreviations"),
        ],
      },
      {
        code: inModule('export const paused = Effect.sleep("1 second");'),
        options: granted("waitsOnTimers", "handlesEveryFailure"),
        errors: [unused("handlesEveryFailure")],
      },
      {
        code: inModule("export const now = new Date();"),
        options: granted("waitsOnTimers"),
        errors: [unused("waitsOnTimers")],
      },
      {
        code: inModule('export const bounded = (work) => work.pipe(Effect.timeout("1 minute"));'),
        options: granted("pollsWithADeadline"),
        errors: [unused("pollsWithADeadline")],
      },
      {
        code: inModule(
          'export const polled = (work) => work.pipe(Effect.repeat(Schedule.spaced("1 second")));',
        ),
        options: grantedInTheTestHome("pollsWithADeadline"),
        errors: [unused("pollsWithADeadline")],
      },
      {
        code: "export const isOne = (value: number): value is 1 => value === 1;",
        options: granted("trustsUnverifiedTypes"),
        errors: [unused("trustsUnverifiedTypes")],
      },
    ],
  }),
});
