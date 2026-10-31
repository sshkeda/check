import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const configReadsStayInConfigFiles = Task.make(
  "no-config-reads rejects environment, raw command-line argument and Effect Config reads",
  ruleTest("no-config-reads", {
    valid: [
      "process.exit(1);",
      "const process = { env: {} }; process.env;",
      'import { Config } from "other"; Config.string("PORT");',
      'import type { Config } from "effect"; type Port = Config.Config<number>;',
      'import { cwd } from "node:process"; cwd();',
      'import { Config, Effect } from "effect"; Effect.catchIf(Config.isConfigError, recover);',
      'import { Config } from "effect"; Schema.instanceOf(Config.ConfigError);',
      'import { Stdio } from "effect"; Stdio.make;',
      'import { Stdio } from "effect"; Stdio.Stdio;',
      'import * as Stdio from "effect/Stdio"; Stdio.Stdio;',
      'import { Config } from "effect"; class Settings { Config(): number { return 1; } }',
      'import { Config } from "effect"; class Settings { Config = 1; }',
    ],
    invalid: [
      ...[
        "process.env.HOME;",
        'process.env["HOME"];',
        "const { env } = process;",
        'import { env } from "node:process";',
        'import { Config } from "effect"; Config.string("PORT");',
        'import { Config as Settings } from "effect"; Settings.int("PORT");',
        'import * as Config from "effect/Config"; Config.schema(Port, "PORT");',
        'import { string } from "effect/Config"; string("PORT");',
        "(process satisfies NodeJS.Process).env.HOME;",
        "(process as NodeJS.Process).env.HOME;",
        "process!.env.HOME;",
        "const runtime = process satisfies NodeJS.Process; runtime.env.HOME;",
        "const { env } = process satisfies NodeJS.Process;",
        'import { Config } from "effect"; (Config satisfies typeof Config).string("PORT");',
        'import * as runtime from "node:process"; (runtime as NodeJS.Process).env.HOME;',
      ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
      ...["Bun.env.HOME;", "import.meta.env.HOME;"].map((code) => ({
        code,
        errors: [{ messageId: "bannedEvenWhenGranted" }],
      })),
    ],
  }),
);

export const rawArgumentsAreBanned = Task.make(
  "no-config-reads rejects process.argv, process.argv0, Bun.argv and parseArgs from node:util however they are reached, through a constant alias of process or Bun or a constant key included",
  ruleTest("no-config-reads", {
    valid: [
      "const process = { argv: [] }; process.argv;",
      "const Bun = { argv: [] }; Bun.argv;",
      'import { cwd } from "node:process"; cwd();',
      'import { inspect } from "node:util"; inspect(1);',
      'import type { ParseArgsConfig } from "node:util";',
      'import { parseArgs } from "other"; parseArgs();',
      'import { Stdio } from "effect"; Stdio.Stdio;',
      "const runtime = { argv: [] }; runtime.argv;",
      "const first = second; const second = first; first.argv;",
    ],
    invalid: [
      {
        code: "process.argv.slice(2);",
        errors: [{ message: "process.argv reads configuration" }],
      },
      {
        code: 'import { parseArgs } from "node:util"; parseArgs({});',
        errors: [
          {
            message:
              "parseArgs from node:util reads configuration, which no file may do; read it through Effect Config, process.env or process.argv in a file allowed readsConfig",
          },
        ],
      },
      ...[
        "const { argv } = process;",
        'import { argv } from "node:process";',
        'import process from "node:process"; process.argv;',
        'import processModule from "node:process"; const { argv } = processModule;',
        'process["argv"];',
        'const KEY = "argv"; process[KEY];',
        'const KEY = "argv" as const; process[KEY];',
        'const FIRST = "argv"; const SECOND = FIRST; process[SECOND];',
        'const KEY = "argv"; const { [KEY]: commandLine } = process;',
        "const runtime = process; runtime.argv;",
      ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
      ...[
        "process.argv0;",
        "Bun.argv;",
        "const { argv0: name } = process;",
        "const { argv } = Bun;",
        'import { argv0 } from "process";',
        'import { argv } from "bun";',
        'import * as processModule from "node:process"; processModule.argv0;',
        'import { parseArgs as parse } from "util";',
        'import * as util from "node:util"; util.parseArgs({});',
        'import util from "node:util"; util.parseArgs({});',
        'import util from "node:util"; const { parseArgs } = util;',
        "const runtime = Bun; const { argv } = runtime;",
        'import processModule from "node:process"; const runtime = processModule; runtime.argv0;',
      ].map((code) => ({ code, errors: [{ messageId: "bannedEvenWhenGranted" }] })),
    ],
  }),
);

export const commandSpawnStaysInOneFile = Task.make(
  "no-command-spawn rejects Bun spawning, child_process imports and Effect ChildProcess",
  ruleTest("no-command-spawn", {
    valid: [
      "const Bun = { spawn: () => 1 }; Bun.spawn();",
      'import type { ChildProcess } from "node:child_process";',
    ],
    invalid: [
      ...[
        'Bun.spawn(["git"]);',
        'import { spawn } from "node:child_process";',
        'import { ChildProcess } from "effect/process"; ChildProcess.make("git", []);',
      ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
      ...[
        'Bun.spawnSync(["git"]);',
        "Bun.$`git status`;",
        'import { execSync } from "child_process";',
      ].map((code) => ({ code, errors: [{ messageId: "bannedEvenWhenGranted" }] })),
    ],
  }),
);

export const serviceDeclarationsStayInApprovedFiles = Task.make(
  "no-service-declarations rejects Context.Service and Context.Reference from effect, naming the declared service when it has a class name",
  ruleTest("no-service-declarations", {
    valid: [
      'import { Context } from "other"; Context.Service;',
      'import { Context } from "effect"; Context.get;',
      "Context.Service;",
    ],
    invalid: [
      {
        code: 'import { Context } from "effect"; class Store extends Context.Service<Store>()("Store") {}',
        errors: [{ message: "Context.Service declares service Store outside a services file" }],
      },
      ...[
        'import { Context } from "effect"; Context.Reference;',
        'import * as Context from "effect/Context"; Context.Service;',
        'import * as Library from "effect"; Library.Context.Service;',
        'import { Service } from "effect/Context"; Service;',
      ].map((code) => ({ code, errors: [{ messageId: "anonymousService" }] })),
      {
        code: 'import { Service as Factory } from "effect/Context"; class Store extends Factory<Store>()("Store") {}',
        errors: [{ message: "Context.Service declares service Store outside a services file" }],
      },
    ],
  }),
);

const GRANTED_STORE = [{ services: ["Store"] }] as const;

export const grantedFilesDeclareOnlyListedNamedServices = Task.make(
  "no-service-declarations in a file granted services reports an unlisted or unnamed service once each",
  ruleTest("no-service-declarations", {
    valid: [
      {
        code: 'import { Context } from "effect"; class Store extends Context.Service<Store>()("Store") {}',
        options: GRANTED_STORE,
      },
    ],
    invalid: [
      {
        code: 'import { Context } from "effect"; class Cache extends Context.Service<Cache>()("Cache") {}',
        options: GRANTED_STORE,
        errors: [{ messageId: "unlisted" }],
      },
      {
        code: 'import { Context } from "effect"; const service = class extends Context.Service()("Store") {};',
        options: GRANTED_STORE,
        errors: [{ messageId: "unnamed" }],
      },
    ],
  }),
);

export const grantedServicesAreDeclared = Task.make(
  "no-unused-service-grants reports each granted service the file does not declare",
  ruleTest("no-unused-service-grants", {
    valid: [
      "export const VALUE = 1;",
      {
        code: 'import { Context } from "effect"; class Store extends Context.Service<Store>()("Store") {}',
        options: GRANTED_STORE,
      },
      {
        code: 'import * as Context from "effect/Context"; const Store = Context.Reference<number>()("Store", { defaultValue: () => 1 });',
        options: GRANTED_STORE,
      },
      {
        code: 'import { Service } from "effect/Context"; class Store extends Service<Store>()("Store") {}',
        options: GRANTED_STORE,
      },
    ],
    invalid: [
      {
        code: "export const VALUE = 1;",
        options: GRANTED_STORE,
        errors: [{ message: "granted service Store is not declared here" }],
      },
      {
        code: 'import { Context } from "other"; class Store extends Context.Service<Store>()("Store") {}',
        options: GRANTED_STORE,
        errors: [{ messageId: "missing" }],
      },
      {
        code: 'import { Context } from "effect"; class Cache extends Context.Service<Cache>()("Cache") {}',
        options: [{ services: ["Store", "Limit"] }],
        errors: [{ messageId: "missing" }, { messageId: "missing" }],
      },
    ],
  }),
);
