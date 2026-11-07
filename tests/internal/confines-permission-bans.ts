import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { bannedUsage, ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const GRANTED = [{ bans: "onlyThoseNoGrantLifts" }] as const;

const bannedEvenWhenGranted = (code: string) => [
  { code, errors: [{ messageId: "bannedEvenWhenGranted" }] },
  { code, options: GRANTED, errors: [{ messageId: "bannedEvenWhenGranted" }] },
];

export const sqlClientsStayInSqlFiles = Task.make(
  "no-sql-clients rejects Effect SQL modules and SqlClient by import identity outside files granted usesSqlDatabases, and every other SQL client in every file",
  ruleTest("no-sql-clients", {
    valid: [
      'import { Effect } from "effect";',
      'import type { SqlClient } from "effect/sql/SqlClient";',
      'import { pgpass } from "pgpass";',
      "const Bun = { sql: 1 }; Bun.sql;",
      'import { serve } from "bun";',
      ...[
        'import { SqliteClient } from "@effect/sql-sqlite-bun";',
        'import { SqlClient } from "effect/sql/SqlClient";',
      ].map((code) => ({ code, options: GRANTED })),
    ],
    invalid: [
      ...[
        'import { SqliteClient } from "@effect/sql-sqlite-bun";',
        'import { SqlClient } from "@effect/sql";',
        'import * as SqlClient from "effect/sql/SqlClient";',
        'import { SqlClient } from "./cache-sqlite.ts";',
        'import * as Cache from "./cache-sqlite.ts"; Cache.SqlClient;',
      ].map((code) => bannedUsage(code)),
      ...[
        'import { Database } from "bun:sqlite";',
        'import { DatabaseSync } from "node:sqlite";',
        'import sqlite3 from "sqlite3";',
        'import Database from "better-sqlite3";',
        'import { Pool } from "pg";',
        'import postgres from "postgres";',
        'import mysql from "mysql2/promise";',
        'import { SQL } from "bun";',
        "Bun.sql`select 1`;",
        "new Bun.SQL();",
      ].flatMap((code) => bannedEvenWhenGranted(code)),
    ],
  }),
);

export const processExitStaysInExitFiles = Task.make(
  "no-process-exit rejects process.exit and exit from node:process, wrapped in a TypeScript as, satisfies or non-null expression included, and leaves type positions alone",
  ruleTest("no-process-exit", {
    valid: [
      "const process = { exit: () => 1 }; process.exit();",
      "process.exitCode;",
      'import type { exit } from "node:process"; type Leave = typeof exit;',
    ],
    invalid: [
      "process.exit(1);",
      'import { exit } from "node:process"; exit(1);',
      "const { exit } = process;",
      'import { exit as leave } from "node:process"; const hidden = leave satisfies typeof leave;',
      'import { exit } from "node:process"; const hidden = exit as typeof exit;',
      'import { exit } from "node:process"; const hidden = exit!;',
      "const hidden = process.exit satisfies object;",
    ].map((code) => bannedUsage(code)),
  }),
);

export const unverifiedTypesStayInGrantedFiles = Task.make(
  "no-unverified-types refuses Schema.declare and Schema.declareConstructor however they are imported, and leaves other schemas alone",
  ruleTest("no-unverified-types", {
    valid: [
      'import { Schema } from "effect"; Schema.Struct({ port: Schema.Number });',
      'import { Schema } from "other"; Schema.declare((input) => input !== null);',
    ],
    invalid: [
      'import { Schema } from "effect"; Schema.declare((input): input is number => input !== null);',
      'import { Schema } from "effect"; Schema.declareConstructor();',
      'import { declare } from "effect/Schema"; declare((input): input is number => input !== null);',
      'import * as Effectful from "effect"; Effectful.Schema.declare(isPort);',
    ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
  }),
);

export const taskNamespaceRunsStayInScripts = Task.make(
  "no-task-main recognizes Task.main by import identity including aliases and destructuring",
  ruleTest("no-task-main", {
    valid: [
      'import { Task } from "@sshkeda/task"; Task.make("build", work);',
      'import { Task } from "other"; Task.main(work);',
      "const Task = { main: () => 1 }; Task.main();",
      'import type { Task } from "@sshkeda/task";',
      'import { Task } from "@sshkeda/task"; Task.exec("git", ["status"]);',
    ],
    invalid: [
      'import { Task } from "@sshkeda/task"; Task.main(work);',
      'import { Task as T } from "@sshkeda/task"; T.main(work);',
      'import { Task as T } from "@sshkeda/task"; const { main: start } = T;',
      'import * as Tasks from "@sshkeda/task"; Tasks.Task.main(work);',
    ].map((code) => bannedUsage(code)),
  }),
);

export const effectChildProcessesNeedTheCommandSpawnPermission = Task.make(
  "no-command-spawn refuses ChildProcess and ChildProcessSpawner from effect/process however they are imported outside files granted spawnsCommands, refuses the Bun and Node spawner layers in every file, and leaves type imports, CommandLine and lookalikes alone",
  ruleTest("no-command-spawn", {
    valid: [
      'import type { ChildProcess } from "effect/process";',
      'import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";',
      'import { CommandLine } from "effect/process"; CommandLine.quote("a b");',
      'import { ChildProcess } from "other"; ChildProcess.make("ls");',
      'import { BunFileSystem } from "@effect/platform-bun"; BunFileSystem.layer;',
      ...[
        'import { ChildProcess } from "effect/process"; ChildProcess.make("ls");',
        'import { spawn } from "node:child_process"; spawn("ls");',
        'Bun.spawn(["ls"]);',
      ].map((code) => ({ code, options: GRANTED })),
    ],
    invalid: [
      ...[
        'import { ChildProcess } from "effect/process"; ChildProcess.make("ls");',
        'import { ChildProcessSpawner } from "effect/process"; ChildProcessSpawner.ChildProcessSpawner;',
        'import { ChildProcess as Command } from "effect/process"; Command.make("ls");',
        'import * as Process from "effect/process"; Process.ChildProcess.make("ls");',
        'import * as Process from "effect/process"; const { ChildProcess } = Process;',
        'import * as ChildProcess from "effect/process/ChildProcess"; ChildProcess.make("ls");',
        'import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";',
      ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
      ...[
        'import { BunChildProcessSpawner } from "@effect/platform-bun"; BunChildProcessSpawner.layer;',
        'import * as Spawner from "@effect/platform-bun/BunChildProcessSpawner"; Spawner.layer;',
        'import { NodeChildProcessSpawner } from "@effect/platform-node"; NodeChildProcessSpawner.layer;',
        'import { execSync } from "node:child_process";',
        'Bun.spawnSync(["ls"]);',
      ].flatMap((code) => bannedEvenWhenGranted(code)),
    ],
  }),
);

export const moduleLoadersNeedTheDynamicImportsPermission = Task.make(
  "no-dynamic-import refuses createRequire from node:module however it is imported outside files granted importsDynamically, refuses node:vm in every file, and leaves other node:module exports and type imports alone",
  ruleTest("no-dynamic-import", {
    valid: [
      'import { isBuiltin } from "node:module"; isBuiltin("fs");',
      'import type { Script } from "node:vm";',
      'import { createRequire } from "other"; createRequire("a");',
      {
        code: 'import { createRequire } from "node:module"; createRequire(import.meta.url).resolve("effect");',
        options: GRANTED,
      },
    ],
    invalid: [
      {
        code: 'import { createRequire } from "node:module"; createRequire(import.meta.url).resolve("effect");',
        errors: [{ message: "createRequire from node:module is banned" }],
      },
      {
        code: 'import { Script } from "node:vm"; new Script("1");',
        errors: [
          {
            message:
              "node:vm loads code in a way no file may; use import() in a file allowed importsDynamically",
          },
        ],
      },
      ...[
        'import { createRequire as require } from "module"; require(import.meta.url).resolve("effect");',
        'import module from "node:module"; module.createRequire(import.meta.url).resolve("effect");',
        'import * as module from "node:module"; const { createRequire } = module;',
        'import { Module } from "node:module"; Module.createRequire(import.meta.url).resolve("effect");',
      ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
      ...[
        'import vm from "vm"; vm.runInThisContext("1");',
        'import * as vm from "node:vm"; vm.runInNewContext("1");',
      ].flatMap((code) => bannedEvenWhenGranted(code)),
    ],
  }),
);

const CREATED_REQUIRE_LOADS =
  "a require createRequire returns loads code in a way no file may; use import() in a file allowed importsDynamically";
const CREATE_REQUIRE_AS_A_VALUE =
  "createRequire used other than by a call loads code in a way no file may; use import() in a file allowed importsDynamically";

export const createdRequiresOnlyResolve = Task.make(
  "no-dynamic-import lets the require createRequire returns only resolve a specifier, directly or through a constant, in a file granted importsDynamically, and refuses calling it, passing it on or passing createRequire on, under any name of node:module, where createRequire itself is allowed",
  ruleTest("no-dynamic-import", {
    valid: [
      'import { createRequire } from "node:module"; createRequire(import.meta.url).resolve("effect");',
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load.resolve("effect"); load.resolve("oxlint");',
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); export const resolveSpecifier: typeof load.resolve = load.resolve;',
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); export const resolved: ReturnType<typeof load.resolve> = load.resolve("effect");',
      'import { Module } from "bun:module"; (Module.createRequire(import.meta.url) as NodeJS.Require).resolve("effect");',
      'import { createRequire } from "node:module"; type Loader = typeof createRequire;',
    ].map((code) => ({ code, options: GRANTED })),
    invalid: [
      ...[
        'import { createRequire } from "node:module"; createRequire(import.meta.url)("node:child_process").exec("ls");',
        'import type * as ChildProcesses from "node:child_process"; import { createRequire } from "node:module"; const load: (id: string) => typeof ChildProcesses = createRequire(import.meta.url); load("node:child_process").exec("echo hi");',
        'import { createRequire } from "module"; const load = createRequire(import.meta.url); load.resolve("effect"); load("node:vm");',
        'import { createRequire } from "bun:module"; let load = createRequire(import.meta.url); load.resolve("effect");',
        'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); export const resolveSpecifier: typeof load.resolve = load.resolve; load("node:vm");',
        'import module from "node:module"; export const load = module.createRequire(import.meta.url);',
        'import { createRequire } from "node:module"; const { cache } = createRequire(import.meta.url);',
      ].map((code) => ({ code, options: GRANTED, errors: [{ message: CREATED_REQUIRE_LOADS }] })),
      ...[
        'import { createRequire } from "node:module"; const make = createRequire; make(import.meta.url)("node:vm");',
        'import { createRequire } from "node:module"; [createRequire];',
        'import { createRequire } from "node:module"; export { createRequire };',
        'import { createRequire } from "node:module"; createRequire.call(undefined, import.meta.url)("node:vm");',
      ].map((code) => ({
        code,
        options: GRANTED,
        errors: [{ message: CREATE_REQUIRE_AS_A_VALUE }],
      })),
    ],
  }),
);

const TYPE_PREDICATES = [
  "export const isPort = (value: number): value is 80 => value === 80;",
  "export function isPort(value: number): value is 80 { return value === 80; }",
  "export const isPort = function (value: number): value is 80 { return value === 80; };",
  "export function assertPort(value: number): asserts value is 80 {}",
  "export function assertTruthy(value: number): asserts value {}",
  "export class Port { public isOpen(): this is { open: true } { return true; } }",
  "export const ports = [80, 443].filter((port): port is 80 => port === 80);",
  "export declare function isPort(value: number): value is 80;",
  'import { Schema } from "other"; export const Port = Schema.declare((input): input is 80 => input === 80);',
] as const;

const SCHEMA_DECLARATION_CALLBACKS = [
  'import { Schema } from "effect"; export const Port = Schema.declare((input): input is 80 => input === 80);',
  'import { Schema } from "effect"; export const Port = Schema.declare(function (input): input is 80 { return input === 80; });',
  'import { declare } from "effect/Schema"; export const Port = declare((input): input is 80 => input === 80);',
] as const;

export const typePredicatesAreRefused = Task.make(
  "no-type-predicates refuses a type predicate, an assertion signature or a this predicate as the return type of any function, arrow, method or declared function, including a callback passed to Schema.declare, and leaves inferred predicates, function types and library guards alone",
  ruleTest("no-type-predicates", {
    valid: [
      'export const ports = [80, "a"].filter((port) => typeof port === "number");',
      'import { Predicate } from "effect"; export const names = ["a", 1].filter(Predicate.isString);',
      "export const select = <Found>(nodes: readonly unknown[], isWanted: (node: unknown) => node is Found) => nodes.filter(isWanted);",
    ],
    invalid: [
      {
        code: "export const isPort = (value: number): value is 80 => value === 80;",
        errors: [{ message: "`value is 80` is an unchecked type predicate" }],
      },
      {
        code: "export function assertTruthy(value: number): asserts value {}",
        errors: [{ message: "`asserts value` is an unchecked type predicate" }],
      },
      ...[...TYPE_PREDICATES, ...SCHEMA_DECLARATION_CALLBACKS].map((code) => ({
        code,
        errors: [{ messageId: "typePredicate" }],
      })),
    ],
  }),
);

export const schemaDeclarationsMayKeepTheirTypePredicate = Task.make(
  "with schemaDeclarations allowed, which a trustsUnverifiedTypes grant sets, no-type-predicates leaves the predicate of a callback passed directly to Schema.declare or declareConstructor and still refuses every other type predicate",
  ruleTest("no-type-predicates", {
    valid: SCHEMA_DECLARATION_CALLBACKS.map((code) => ({
      code,
      options: [{ schemaDeclarations: "allowed" }],
    })),
    invalid: [
      ...TYPE_PREDICATES,
      'import { Schema } from "effect"; const isPort = (input: number): input is 80 => input === 80; export const Port = Schema.declare(isPort);',
      'import { Schema } from "effect"; export const Port = Schema.declare((input) => [(value: number): value is 80 => value === 80, input]);',
    ].map((code) => ({
      code,
      options: [{ schemaDeclarations: "allowed" }],
      errors: [{ messageId: "typePredicate" }],
    })),
  }),
);
