import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { PLUGIN } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { oxlintBinary } from "../shared/oxlint-binary.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const DATE_NOW_REPORTS = 2;
const PERFORMANCE_REPORTS = 3;

const lintRestrictions = (source: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const plugin = yield* encodeJson(PLUGIN);
    yield* fileSystem.writeFileString(
      path.join(directory, "oxlint.config.ts"),
      `import { lintConfig } from ${plugin};
const config = lintConfig({});
const restrictions = ["sshkeda/no-timer-globals", "sshkeda/no-global-object", "sshkeda/no-clock-reads-and-sleeps", "eslint/no-restricted-properties", "eslint/no-restricted-imports", "sshkeda/no-re-exports"];
export default { jsPlugins: config.jsPlugins, rules: Object.fromEntries(restrictions.map((rule) => [rule, config.rules[rule]])) };`,
    );
    yield* fileSystem.writeFileString(path.join(directory, "main.ts"), source);
    return yield* Task.exec(
      "bun",
      [
        yield* oxlintBinary,
        "--config",
        path.join(directory, "oxlint.config.ts"),
        "--format",
        "agent",
        "main.ts",
      ],
      { cwd: directory },
    );
  }).pipe(Effect.scoped);

export const rejectsNativeReplacementsOutsideEffect = Task.make({
  name: "JSON and timers are rejected",
  run: Effect.gen(function* () {
    const failure = yield* lintRestrictions(`export const decoded = JSON.parse("1");
export const encoded = JSON.stringify(1);
export const timer = setTimeout(() => undefined, 1);
`).pipe(failureAsValue);
    expect(failure.message).toContain("'JSON.parse' is restricted");
    expect(failure.message).toContain("'JSON.stringify' is restricted");
    expect(failure.message).toContain(
      "main.ts:3:22: error sshkeda(no-timer-globals): global setTimeout is used",
    );
  }),
});

export const rejectsDateNowLikeOtherClockReads = Task.make({
  name: "Date.now is rejected like the performance global, process.hrtime, process.uptime, Bun.nanoseconds, AbortSignal.timeout and Bun.sleepSync, including when passed as a value",
  run: Effect.gen(function* () {
    const failure = yield* lintRestrictions(`import { Effect } from "effect";
export const startedAt = Date.now();
export const readClock = Effect.sync(Date.now);
export const elapsed = performance.now();
export const origin = performance.timeOrigin + performance.mark("start").startTime;
export const nanoseconds = process.hrtime.bigint();
export const uptime = process.uptime();
export const counted = Bun.nanoseconds();
export const aborted = AbortSignal.timeout(1);
export const paused = Bun.sleepSync(1);
`).pipe(failureAsValue);
    expect(failure.message.match(/'Date\.now' is restricted/gu)?.length).toBe(DATE_NOW_REPORTS);
    expect(failure.message.match(/global performance is used/gu)?.length).toBe(PERFORMANCE_REPORTS);
    for (const member of [
      "process.hrtime",
      "process.uptime",
      "Bun.nanoseconds",
      "AbortSignal.timeout",
      "Bun.sleepSync",
    ]) {
      expect(failure.message).toContain(`sshkeda(no-clock-reads-and-sleeps): ${member} is banned`);
    }
  }),
});

export const allowsLocalObjectsWithClockPropertyNames = Task.make({
  name: "local process and Bun objects with clock method names pass the preset's clock restrictions",
  run: lintRestrictions(`const process = { uptime: () => 7, hrtime: () => 9 };
const Bun = { nanoseconds: () => 11, sleepSync: () => 13 };
const AbortSignal = { timeout: () => 17 };
export const values = [process.uptime(), process.hrtime(), Bun.nanoseconds(), Bun.sleepSync(), AbortSignal.timeout()];
`).pipe(Effect.asVoid),
});

export const rejectsBunImportsOfRestrictedMembers = Task.make({
  name: "bun imports of restricted Bun and process members are rejected by no-restricted-imports, and their re-exports by no-re-exports",
  run: Effect.gen(function* () {
    const failure = yield* lintRestrictions(`import { file } from "bun";
import { exitCode } from "node:process";
export { write } from "bun";
export const read = () => file("trace.log");
export const code = exitCode;
`).pipe(failureAsValue);
    expect(failure.message).toContain(
      "eslint(no-restricted-imports): 'file' import from 'bun' is restricted.",
    );
    expect(failure.message).toContain(
      "sshkeda(no-re-exports): export from bun re-exports another module",
    );
    expect(failure.message).toContain(
      "eslint(no-restricted-imports): 'exitCode' import from 'node:process' is restricted.",
    );
  }),
});

export const rejectsGetBuiltinModule = Task.make({
  name: "process.getBuiltinModule is rejected outright so it cannot load banned built-ins",
  run: Effect.gen(function* () {
    const failure =
      yield* lintRestrictions(`export const childProcess = process.getBuiltinModule("node:child_process");
`).pipe(failureAsValue);
    expect(failure.message).toContain("'process.getBuiltinModule' is restricted");
  }),
});

export const rejectsParsingWithoutASchema = Task.make({
  name: "json() bodies, parseInt, parseFloat and Schema.Any are rejected however they are reached, while json with arguments, Effect's own parsers and lookalikes pass",
  run: ruleTest("no-unchecked-parsing", {
    valid: [
      'import { Schema } from "effect"; Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Number))(text);',
      'import { Schema } from "other"; Schema.Any;',
      "encoder.json(value);",
      "const parseInt = (text: string) => text.length; parseInt(text);",
      'import { Number } from "effect"; Number.parse(text);',
      "const Number = { parseFloat: (text: string) => text.length }; Number.parseFloat(text);",
    ],
    invalid: [
      ...[
        "new Response(text).json();",
        "Effect.promise(() => request.json()).pipe(Effect.map((flags: { readonly on: boolean }) => flags.on));",
        "await Bun.$`claude agents --json`.json();",
      ].map((code) => ({ code, errors: [{ messageId: "jsonBody" }] })),
      ...["parseInt(text, 10);", "Number.parseFloat(text);", "texts.map(parseFloat);"].map(
        (code) => ({ code, errors: [{ messageId: "numberParse" }] }),
      ),
      ...[
        'import { Schema } from "effect"; Schema.decodeEffect(Schema.fromJsonString(Schema.Any))(text);',
        'import { Any } from "effect/Schema"; Any;',
        'import * as Effectful from "effect"; Effectful.Schema.Any;',
        'import { Schema } from "effect"; Schema.decodeUnknownEffect(Schema.Any.annotate({ title: "payload" }))(input);',
      ].map((code) => ({ code, errors: [{ messageId: "uncheckedSchema" }] })),
    ],
  }),
});

export const allowsLocallyImplementedJsonMethods = Task.make({
  name: "locally implemented json methods pass, while unchecked parsing inside them is rejected",
  run: ruleTest("no-unchecked-parsing", {
    valid: [
      "const encoder = { json() { return { count: 1 }; } }; encoder.json();",
      "const encoder = { json: () => ({ count: 1 }) }; encoder.json();",
      "({ json() { return { count: 1 }; } }).json();",
      "class Encoder { json() { return { count: 1 }; } } const encoder = new Encoder(); encoder.json();",
    ],
    invalid: [
      {
        code: "const encoder = { json() { return response.json(); } }; encoder.json();",
        errors: [{ messageId: "jsonBody" }],
      },
    ],
  }),
});

export const allowsJsonPromisesDecodedWithThen = Task.make({
  name: "json promises passed straight to a Schema decoder through then pass, while transforms and lookalike decoders are rejected",
  run: ruleTest("no-unchecked-parsing", {
    valid: [
      'import { Schema } from "effect"; response.json().then(Schema.decodeUnknownSync(Body));',
      'import { decodeUnknownPromise } from "effect/Schema"; response.json().then(decodeUnknownPromise(Body));',
    ],
    invalid: [
      'import { Schema } from "other"; response.json().then(Schema.decodeUnknownSync(Body));',
      'import { Schema } from "effect"; response.json().then(transform).then(Schema.decodeUnknownSync(Body));',
      'import { Schema } from "effect"; response.json().then(Schema.encodeUnknownSync(Body));',
      'import { Schema } from "effect"; response.json().then(undefined, Schema.decodeUnknownSync(Body));',
      'import { Schema } from "effect"; other(Schema.decodeUnknownSync(Body), response.json().then);',
    ].map((code) => ({ code, errors: [{ messageId: "jsonBody" }] })),
  }),
});

export const allowsParsingNoSchemaReplaces = Task.make({
  name: "parseInt with a radix no Schema decodes, and a json() body that goes straight into a Schema decoder or an unknown binding, pass, while decimal parses and other json() uses are rejected",
  run: ruleTest("no-unchecked-parsing", {
    valid: [
      "Number.parseInt(digits, 16);",
      "parseInt(octet, 0x10);",
      "const OCTAL = 8; Number.parseInt(permissions, OCTAL);",
      "const HEXADECIMAL = 16 as const; texts.map((text) => Number.parseInt(text, HEXADECIMAL));",
      'import { Effect, Schema } from "effect"; Effect.gen(function* () { return yield* Schema.decodeUnknownEffect(Body)(yield* Effect.promise(() => response.json())); });',
      'import { Effect } from "effect"; Effect.gen(function* () { const body: unknown = yield* Effect.promise(() => response.json()); return body; });',
      'import { Schema } from "effect"; const body = Schema.decodeUnknownSync(Body)(await response.json());',
      'import { Effect, Schema } from "effect"; Effect.promise(async () => await response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Body)));',
      'import { Schema } from "effect"; Schema.decodeUnknownSync(Body)(await response.json(), { errors: "all" });',
      'import { Effect, Schema } from "effect"; Effect.flatMap(Effect.promise(() => response.json()), Schema.decodeUnknownEffect(Body));',
      'import { Effect, pipe, Schema } from "effect"; pipe(Effect.promise(() => response.json()), Effect.flatMap(Schema.decodeUnknownEffect(Body)));',
      'import { Effect, Schema } from "effect"; import { pipe } from "effect/Function"; pipe(Effect.promise(() => response.json()), Effect.flatMap(Schema.decodeUnknownEffect(Body)));',
      "const RADIX = 16 satisfies number; Number.parseInt(digits, RADIX);",
      'import { Effect } from "effect"; import { decodeUnknownEffect } from "effect/Schema"; Effect.gen(function* () { return yield* decodeUnknownEffect(Body)(yield* Effect.tryPromise({ try: () => response.json(), catch: () => new BodyUnreadable() })); });',
    ],
    invalid: [
      ...[
        "Number.parseInt(text);",
        "Number.parseInt(text, 10);",
        "const DECIMAL = 10; Number.parseInt(text, DECIMAL);",
        "let radix = 16; Number.parseInt(text, radix);",
        "const parse = (text: string, radix: number) => Number.parseInt(text, radix);",
        "texts.map(parseInt);",
        "Number.parseFloat(text, 16);",
        "Number.parseInt(text, 0);",
        "Number.parseInt(text, 37);",
      ].map((code) => ({ code, errors: [{ messageId: "numberParse" }] })),
      ...[
        'import { Effect } from "effect"; Effect.gen(function* () { const body = yield* Effect.promise(() => response.json()); return body; });',
        'import { Effect } from "effect"; Effect.gen(function* () { const body: { readonly on: boolean } = yield* Effect.promise(() => response.json()); return body; });',
        'import { Effect, Schema } from "effect"; Effect.gen(function* () { return yield* Schema.decodeUnknownEffect(Body)(Effect.promise(() => response.json())); });',
        'import { Effect, Schema } from "effect"; Effect.promise(() => response.json()).pipe(Effect.map((body) => body.on), Effect.flatMap(Schema.decodeUnknownEffect(Body)));',
        'import { Effect, Schema } from "other"; Effect.gen(function* () { return yield* Schema.decodeUnknownEffect(Body)(yield* Effect.promise(() => response.json())); });',
        'import { Effect, Schema } from "effect"; Effect.gen(function* () { return yield* Schema.decodeUnknownEffect(Body)(yield* Effect.promise(() => { return response.json(); })); });',
        'import { Schema } from "effect"; Schema.decodeUnknownSync(Body)(fallback, await response.json());',
        'import { Schema } from "effect"; Schema.encodeUnknownSync(Body)(await response.json());',
        'import { Schema } from "effect"; Schema.decodeTo(Schema.Number)(await response.json());',
        'import { Effect, Schema } from "effect"; Effect.flatMap(Effect.promise(() => response.json()), Schema.encodeUnknownEffect(Body));',
        'import { Effect, Schema } from "effect"; const pipe = (...steps: ReadonlyArray<unknown>) => steps; pipe(Effect.promise(() => response.json()), Effect.flatMap(Schema.decodeUnknownEffect(Body)));',
        'import { Schema } from "effect"; const decoded = Schema.decodeUnknownSync(Body); decoded(await response.json());',
      ].map((code) => ({ code, errors: [{ messageId: "jsonBody" }] })),
    ],
  }),
});
