import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const IMPORTS = 'import { Clock, Effect, Option, Stream, pipe } from "effect";';

const GRANTED = [{ fixedFallbacks: "granted" }] as const;

const fixed = (operation: string, failure: string, value: string) => ({
  message: `${operation} answers ${failure} with the fixed value ${value} and never reads the failure. Name the reason you expect, or fail`,
});

const recovering = (recovery: string) =>
  `${IMPORTS} export const run = (work) => work.pipe(${recovery});`;

const inModule = (body: string) => `${IMPORTS} ${body}`;

export const fixedFallbacksAreRefused = Task.make(
  "no-fixed-fallbacks refuses a catch-all or a whole library error that answers with a fixed value and never reads the failure, and leaves named reasons, own tags, failure-reading handlers, timeouts, picked failures and granted files alone",
  ruleTest("no-fixed-fallbacks", {
    valid: [
      recovering('Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([]))'),
      recovering('Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone)'),
      recovering('Effect.catchReasons("PlatformError", { PermissionDenied: () => Effect.void })'),
      inModule(
        'export const run = (work) => Effect.catchReason(work, "PlatformError", "NotFound", () => Effect.succeed(""));',
      ),
      recovering('Effect.catchTag("Missing", () => Effect.succeed([]))'),
      recovering(
        "Effect.catchTags({ Missing: () => Effect.succeed(0), Locked: () => Effect.void })",
      ),
      recovering('Stream.catchTag("Missing", () => Stream.empty)'),
      recovering(
        'Effect.catchTag("CommandFailed", (failure) => failure.code === 1 ? Effect.succeed(false) : Effect.fail(failure))',
      ),
      recovering(
        'Effect.catchTag("PlatformError", (error) => { if (isGone(error)) { return Effect.succeed(""); } return Effect.fail(error); })',
      ),
      recovering(
        'Effect.catchTag("PlatformError", (error) => Effect.logWarning(error).pipe(Effect.as([])))',
      ),
      recovering(
        "Effect.catch((error) => Effect.gen(function* () { yield* Effect.logError(error); return 0; }))",
      ),
      recovering(
        'Effect.catchTag("SchemaError", ({ message }) => Effect.logWarning(message).pipe(Effect.as({})))',
      ),
      recovering('Effect.catchTag("PlatformError", (error) => Effect.fail(new Other({ error })))'),
      recovering('Effect.catchTag("PlatformError", () => findArchived(target))'),
      recovering('Effect.catchTag("PlatformError", Effect.succeed)'),
      recovering('Effect.timeoutOption("1 second"), Effect.map(Option.getOrElse(() => "silent"))'),
      recovering("Effect.catchIf(isMissing, () => Effect.succeed(0))"),
      recovering("Effect.catchFilter(isMissing, () => Effect.succeed(0))"),
      recovering("Effect.catchTags({ PlatformError: () => Effect.succeed([]), ...handlers })"),
      recovering("Effect.option, Effect.map(Option.isSome)"),
      recovering("Effect.map(Option.getOrElse(() => 0))"),
      inModule('export const shown = (found) => Option.getOrElse(found, () => "");'),
      inModule(
        "export const read = Effect.try({ try: () => parse(text), catch: () => new Unparsable() });",
      ),
      inModule(
        "export const read = () => { try { return parse(text); } catch (error) { return describe(error); } };",
      ),
      inModule(
        "export const read = () => { try { return parse(text); } catch (error) { log(error); return []; } };",
      ),
      inModule("export const read = () => load().catch((error) => fallbackFor(error));"),
      'import { Effect } from "other"; export const run = (work) => work.pipe(Effect.catch(() => Effect.succeed([])));',
      {
        code: recovering('Effect.catchTag("PlatformError", () => Effect.succeed([]))'),
        options: GRANTED,
      },
      inModule(
        'export const recover = (lastKnown) => { const cached = { value: 0 }; cached.value = lastKnown; return Effect.fail("offline").pipe(Effect.catch(() => Effect.succeed(cached))); };',
      ),
      inModule(
        "export const recover = (work, names) => { const seen = new Map(); for (const name of names) { seen.set(name, 1); } return work.pipe(Effect.catch(() => Effect.succeed(seen))); };",
      ),
      inModule(
        "export const recover = (work, names) => { const found = []; found.push(...names); return work.pipe(Effect.catch(() => Effect.succeed(found))); };",
      ),
      recovering(
        'Effect.catch(Effect.fn("recover")(function* (error) { yield* Effect.logError(error); return 0; }))',
      ),
      recovering("Effect.catch(Effect.fnUntraced(function* (error) { return describe(error); }))"),
      {
        code: recovering('Effect.catch(Effect.fn("recover")(function* () { return 0; }))'),
        options: GRANTED,
      },
      inModule(
        "export const run = (work) => Effect.matchCause(work, { onFailure: (cause) => describe(cause), onSuccess: (value) => value });",
      ),
      recovering(
        "Effect.matchCauseEffect({ onFailure: (cause) => Effect.fail(cause), onSuccess: Effect.succeed })",
      ),
    ],
    invalid: [
      {
        code: recovering(
          "Effect.catchTags({ PlatformError: () => Effect.succeed({}), SchemaError: () => Effect.succeed({}) })",
        ),
        errors: [
          fixed("Effect.catchTags", "PlatformError", "{}"),
          fixed("Effect.catchTags", "SchemaError", "{}"),
        ],
      },
      {
        code: recovering('Effect.catchTag("CommandFailed", () => Effect.succeedNone)'),
        errors: [fixed("Effect.catchTag", "CommandFailed", "Effect.succeedNone")],
      },
      {
        code: recovering('Stream.catchTag("SchemaError", () => Stream.empty)'),
        errors: [fixed("Stream.catchTag", "SchemaError", "Stream.empty")],
      },
      {
        code: recovering('Effect.catchTag("PlatformError", (error) => Effect.succeed([]))'),
        errors: [fixed("Effect.catchTag", "PlatformError", "[]")],
      },
      {
        code: recovering('Effect.catchTag("PlatformError", ({ reason }) => Effect.succeed(0))'),
        errors: [fixed("Effect.catchTag", "PlatformError", "0")],
      },
      {
        code: inModule(
          "export const read = () => { try { return parse(text); } catch { return []; } };",
        ),
        errors: [fixed("catch", "every thrown error", "[]")],
      },
      {
        code: inModule(
          "export const read = () => { try { return parse(text); } catch (error) { return null; } };",
        ),
        errors: [fixed("catch", "every thrown error", "null")],
      },
      {
        code: recovering("Effect.orElseSucceed(() => compute())"),
        errors: [fixed("Effect.orElseSucceed", "every failure", "compute()")],
      },
      {
        code: recovering(
          'Effect.catchTag("Missing", (error) => Effect.fail(error), () => Effect.succeed(0))',
        ),
        errors: [fixed("Effect.catchTag", "the failures it does not name", "0")],
      },
      {
        code: recovering(
          'Effect.catchReason("PlatformError", "NotFound", (error) => Effect.fail(error), () => Effect.succeed([]))',
        ),
        errors: [fixed("Effect.catchReason", "the failures it does not name", "[]")],
      },
      {
        code: recovering(
          'Effect.catchReasons("PlatformError", { NotFound: Effect.fail }, () => Effect.void)',
        ),
        errors: [fixed("Effect.catchReasons", "the failures it does not name", "Effect.void")],
      },
      {
        code: recovering(
          "Effect.catchTags({ Missing: () => Effect.succeed(0) }, () => Effect.succeed(false))",
        ),
        errors: [fixed("Effect.catchTags", "the failures it does not name", "false")],
      },
      {
        code: inModule(
          'export const run = (work) => Effect.catchTag(work, "PlatformError", () => Effect.succeed(""));',
        ),
        errors: [fixed("Effect.catchTag", "PlatformError", '""')],
      },
      {
        code: recovering('Effect.catchTag(["Missing", "PlatformError"], () => Effect.void)'),
        errors: [fixed("Effect.catchTag", "PlatformError", "Effect.void")],
      },
      {
        code: recovering(
          "Effect.catchTags({ PlatformError: (error) => Effect.fail(error), PlatformError: () => Effect.succeedNone })",
        ),
        errors: [fixed("Effect.catchTags", "PlatformError", "Effect.succeedNone")],
      },
      {
        code: recovering("Effect.catch(() => Effect.succeed(false))"),
        errors: [fixed("Effect.catch", "every failure", "false")],
      },
      {
        code: recovering('Effect.catch(() => Effect.succeed("unknown" as const))'),
        errors: [fixed("Effect.catch", "every failure", '"unknown"')],
      },
      {
        code: recovering("Effect.catchEager(() => Effect.succeed(0))"),
        errors: [fixed("Effect.catchEager", "every failure", "0")],
      },
      {
        code: inModule("export const run = (work) => Effect.catchCause(work, () => Effect.void);"),
        errors: [fixed("Effect.catchCause", "every cause", "Effect.void")],
      },
      {
        code: recovering("Effect.orElse(() => Effect.succeed({}))"),
        errors: [fixed("Effect.orElse", "every failure", "{}")],
      },
      {
        code: inModule(
          "export const run = (work) => Effect.match(work, { onFailure: () => 0, onSuccess: (value) => value });",
        ),
        errors: [fixed("Effect.match", "every failure", "0")],
      },
      {
        code: recovering(
          "Effect.matchEffect({ onFailure: () => Effect.succeed([]), onSuccess: Effect.succeed })",
        ),
        errors: [fixed("Effect.matchEffect", "every failure", "[]")],
      },
      {
        code: recovering('Effect.option, Effect.map(Option.getOrElse(() => ""))'),
        errors: [fixed("Effect.option", "every failure", '""')],
      },
      {
        code: inModule(
          "export const run = (work) => Effect.map(Effect.option(work), Option.getOrElse(() => 0));",
        ),
        errors: [fixed("Effect.option", "every failure", "0")],
      },
      {
        code: inModule(
          "export const run = (work) => pipe(work, Effect.option, Effect.map(Option.getOrElse(() => [])));",
        ),
        errors: [fixed("Effect.option", "every failure", "[]")],
      },
      {
        code: inModule("export const read = () => load().catch(() => null);"),
        errors: [fixed("catch", "every rejection", "null")],
      },
      {
        code: recovering(
          'Effect.catch(() => Effect.gen(function* () { yield* Effect.logWarning("missing"); return []; }))',
        ),
        errors: [fixed("Effect.catch", "every failure", "[]")],
      },
      {
        code: recovering('Effect.catch(() => Effect.logWarning("missing").pipe(Effect.as(false)))'),
        errors: [fixed("Effect.catch", "every failure", "false")],
      },
      {
        code: recovering("Effect.catch(() => Effect.sync(() => []))"),
        errors: [fixed("Effect.catch", "every failure", "[]")],
      },
      {
        code: inModule(
          "const START_OF_FILE = 0n; export const run = (work) => work.pipe(Effect.catch(() => Effect.succeed(START_OF_FILE)));",
        ),
        errors: [fixed("Effect.catch", "every failure", "START_OF_FILE")],
      },
      {
        code: inModule(
          "const absent = Effect.succeed(false); export const run = (work) => work.pipe(Effect.catch(() => absent));",
        ),
        errors: [fixed("Effect.catch", "every failure", "false")],
      },
      {
        code: recovering("Effect.catch(() => Effect.succeed({ sessions: [], isReadable: false }))"),
        errors: [fixed("Effect.catch", "every failure", "{ sessions: [], isReadable: false }")],
      },
      {
        code: recovering("Effect.catch(() => Effect.succeed(Option.none()))"),
        errors: [fixed("Effect.catch", "every failure", "Option.none()")],
      },
      {
        code: recovering("Effect.catch(() => Effect.succeed(Date.now()))"),
        errors: [fixed("Effect.catch", "every failure", "Date.now()")],
      },
      {
        code: recovering("Effect.catch(() => Clock.currentTimeMillis)"),
        errors: [fixed("Effect.catch", "every failure", "Clock.currentTimeMillis")],
      },
      {
        code: inModule(
          'const recover = Effect.catchTag("PlatformError", () => Effect.succeed([])); export const run = (work) => work.pipe(recover);',
        ),
        errors: [fixed("Effect.catchTag", "PlatformError", "[]")],
      },
      {
        code: inModule("export const run = 1;"),
        options: GRANTED,
        errors: [{ messageId: "unusedGrant" }],
      },
      {
        code: inModule(
          'export const recover = () => { const NOTHING_YET = 0; return Effect.fail("offline").pipe(Effect.catch(() => Effect.succeed(NOTHING_YET))); };',
        ),
        errors: [fixed("Effect.catch", "every failure", "NOTHING_YET")],
      },
      {
        code: inModule(
          "const EMPTY = { sessions: [] }; export const run = (work) => work.pipe(Effect.catch(() => Effect.succeed(EMPTY)));",
        ),
        errors: [fixed("Effect.catch", "every failure", "EMPTY")],
      },
      {
        code: recovering('Effect.catch(Effect.fn("recover")(function* () { return 0; }))'),
        errors: [fixed("Effect.catch", "every failure", "0")],
      },
      {
        code: recovering("Effect.catch(Effect.fn(function* (error) { return []; }))"),
        errors: [fixed("Effect.catch", "every failure", "[]")],
      },
      {
        code: recovering('Effect.catch(Effect.fnUntraced(function* () { return ""; }))'),
        errors: [fixed("Effect.catch", "every failure", '""')],
      },
      {
        code: inModule(
          "export const run = (work) => Effect.matchCause(work, { onFailure: () => 0, onSuccess: (value) => value });",
        ),
        errors: [fixed("Effect.matchCause", "every cause", "0")],
      },
      {
        code: recovering(
          "Effect.matchCauseEffect({ onFailure: () => Effect.succeed([]), onSuccess: Effect.succeed })",
        ),
        errors: [fixed("Effect.matchCauseEffect", "every cause", "[]")],
      },
      {
        code: recovering(
          "Effect.matchCauseEager({ onFailure: () => false, onSuccess: (value) => value })",
        ),
        errors: [fixed("Effect.matchCauseEager", "every cause", "false")],
      },
      {
        code: recovering(
          "Effect.matchCauseEffectEager({ onFailure: () => Effect.void, onSuccess: Effect.succeed })",
        ),
        errors: [fixed("Effect.matchCauseEffectEager", "every cause", "Effect.void")],
      },
      {
        code: recovering(
          "Effect.matchEager({ onFailure: () => null, onSuccess: (value) => value })",
        ),
        errors: [fixed("Effect.matchEager", "every failure", "null")],
      },
    ],
  }),
);
