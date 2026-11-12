import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const WHOLE_NAMESPACE =
  "is used without naming a member, so the bans on its members can't see which one runs";

const usedWhole = (name: string) => ({ message: `${name} ${WHOLE_NAMESPACE}` });

export const namespacesNeedAMember = Task.make({
  name: "no-namespace-aliases reports an Effect module, a module or namespace a permission ban names members of, or a banned global that is aliased, destructured, spread, passed or read with a computed key, and leaves members, calls, typeof, instanceof, Object.keys, types and local names alone",
  run: ruleTest("no-namespace-aliases", {
    valid: [
      'import { Effect } from "effect"; work.pipe(Effect.orDie);',
      'import { Effect } from "effect"; const run = Effect["map"];',
      'import * as Effects from "effect"; Effects.Effect.succeed(1);',
      'import { pipe } from "effect"; const piped = pipe(1, (value) => value);',
      'import { succeed } from "effect/Effect"; const lifted = succeed;',
      'import { Schema } from "effect"; const Name = Schema.String;',
      'import type { Effect } from "effect"; type Work = Effect.Effect<void>;',
      'import { Effect } from "effect"; type Module = typeof Effect;',
      "const parsed = JSON.parse(text);",
      "const moment = new Date(0);",
      "const isMoment = value instanceof Date;",
      'const hasBun = typeof Bun !== "undefined";',
      "const JSON = { parse: (text: string) => text }; const Text = JSON;",
      'import { Effect } from "other"; const Run = Effect;',
      'import { process } from "./processor.ts"; const callback = process;',
      'import { Stream } from "effect"; const recover = Stream.catch;',
      'import { parseArgs } from "./arguments.ts"; const parse = parseArgs;',
      'import * as Local from "./node-util.ts"; const Library = Local;',
      'import type * as Util from "node:util"; type Parse = typeof Util.parseArgs;',
      "const Atomics = { wait: () => 0 }; const waits = Atomics;",
      'import { Task } from "@sshkeda/task"; const Tasks = Task; Tasks.make(definition);',
    ],
    invalid: [
      {
        code: 'import * as Library from "effect"; const Run = ((Library as typeof Library) satisfies object).Effect;',
        errors: [usedWhole("Library")],
      },
      {
        code: "const parse = (JSON as typeof JSON).parse;",
        errors: [usedWhole("JSON")],
      },
      {
        code: 'import { Effect } from "effect"; const Run = Effect; work.pipe(Run.orDie);',
        errors: [usedWhole("Effect")],
      },
      {
        code: 'import { Effect } from "effect"; const { orDie } = Effect;',
        errors: [usedWhole("Effect")],
      },
      {
        code: 'import * as Steps from "effect/Effect"; const Run = { ...Steps };',
        errors: [usedWhole("Steps")],
      },
      {
        code: 'import * as Effects from "effect"; const Run = Effects.Effect;',
        errors: [usedWhole("Effects.Effect")],
      },
      {
        code: 'import * as Effects from "effect"; const Library = Effects;',
        errors: [usedWhole("Effects")],
      },
      {
        code: 'import { Stream } from "effect"; const run = (name: string) => Stream[name];',
        errors: [usedWhole("Stream")],
      },
      {
        code: 'import { Stream } from "effect"; const KEY = "orDie"; const run = Stream[KEY];',
        errors: [usedWhole("Stream")],
      },
      {
        code: 'import * as Util from "node:util"; const library = Util; library.parseArgs();',
        errors: [usedWhole("Util")],
      },
      {
        code: 'import Util from "util"; const KEY = "parseArgs"; Util[KEY]();',
        errors: [usedWhole("Util")],
      },
      {
        code: 'import * as Process from "effect/process"; const commands = Process; commands.ChildProcess.make("ls");',
        errors: [usedWhole("Process")],
      },
      {
        code: 'import { Schema } from "effect"; const schemas = Schema; const Text = schemas.declare(isText);',
        errors: [usedWhole("Schema")],
      },
      {
        code: 'import * as Effects from "effect"; const { Stream: { orDie } } = Effects;',
        errors: [usedWhole("Effects")],
      },
      {
        code: 'import { Effect } from "effect"; const Run = Effect; inspect(Run);',
        errors: [usedWhole("Effect")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe((0, Effect).orDie);',
        errors: [usedWhole("Effect")],
      },
      { code: "const waits = Atomics; waits.wait(cell, 0, 0, 1);", errors: [usedWhole("Atomics")] },
      { code: "const numbers = texts.map(Number);", errors: [usedWhole("Number")] },
      {
        code: 'import { Effect } from "effect"; const members = Object.values(Effect);',
        errors: [usedWhole("Effect")],
      },
      {
        code: 'import { Effect } from "effect"; const members = Object.entries(Effect);',
        errors: [usedWhole("Effect")],
      },
      {
        code: 'import { Effect } from "effect"; const members = Object.getOwnPropertyDescriptors(Effect);',
        errors: [usedWhole("Effect")],
      },
      {
        code: 'import { Effect } from "effect"; const Object = { keys: (value: unknown) => value }; Object.keys(Effect);',
        errors: [usedWhole("Effect")],
      },
      { code: "const formats = Intl; new formats.DateTimeFormat();", errors: [usedWhole("Intl")] },
      { code: "const Numbers = Number; Numbers.parseFloat(text);", errors: [usedWhole("Number")] },
      {
        code: 'import * as Module from "node:module"; const loader = Module; loader.createRequire(import.meta.url);',
        errors: [usedWhole("Module")],
      },
      {
        code: 'import Module from "node:module"; const KEY = "createRequire"; Module[KEY](import.meta.url);',
        errors: [usedWhole("Module")],
      },
      {
        code: 'import { Module } from "node:module"; const Loader = Module; Loader.createRequire(import.meta.url);',
        errors: [usedWhole("Module")],
      },
      {
        code: 'import * as Modules from "node:module"; const { Module: { createRequire } } = Modules;',
        errors: [usedWhole("Modules")],
      },
      {
        code: 'import { BunChildProcessSpawner } from "@effect/platform-bun"; const Spawner = BunChildProcessSpawner;',
        errors: [usedWhole("BunChildProcessSpawner")],
      },
      {
        code: 'import * as Runtime from "bun"; const KEY = "spawn"; Runtime[KEY](["ls"]);',
        errors: [usedWhole("Runtime")],
      },
      {
        code: 'import { Layer } from "effect"; register(Layer as unknown);',
        errors: [usedWhole("Layer")],
      },
      {
        code: 'import { HttpClient } from "effect/http"; const Client = HttpClient;',
        errors: [usedWhole("HttpClient")],
      },
      { code: "const Text = JSON; Text.parse(text);", errors: [usedWhole("JSON")] },
      { code: "const Moment = Date; Moment.now();", errors: [usedWhole("Date")] },
      { code: "const methods = { Reflect };", errors: [usedWhole("Reflect")] },
      { code: "const output = console; output.log(1);", errors: [usedWhole("console")] },
      { code: "inspect(process);", errors: [usedWhole("process")] },
      {
        code: 'import * as Runtime from "bun"; const Server = Runtime;',
        errors: [usedWhole("Runtime")],
      },
      {
        code: 'import * as Library from "effect"; const Run = (Library satisfies object).Effect;',
        errors: [usedWhole("Library")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe((Effect as typeof Effect).orDie);',
        errors: [usedWhole("Effect")],
      },
    ],
  }),
});
