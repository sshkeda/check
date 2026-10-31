import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { bannedUsage, ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const bunNamedImportsCountAsBunMembers = Task.make(
  "bun named, default and namespace imports count as the Bun members they reach, a literal import() of node:child_process is refused like its static import, and import {} is left to no-import-type-side-effects",
  ruleTest("no-command-spawn", {
    valid: [
      'import { Glob } from "bun";',
      'import type { Subprocess } from "bun";',
      'import { type Subprocess } from "bun";',
      'import Runtime from "bun"; new Runtime.Glob("*.ts");',
      'export { Glob } from "bun";',
      "const Runtime = { spawn: () => 1 }; Runtime.spawn();",
      'import {} from "node:child_process";',
      'const loaded = import("bun");',
    ],
    invalid: [
      ...[
        'import { spawn } from "bun";',
        'import Runtime from "bun"; Runtime.spawn(["git"]);',
        'import Runtime from "bun"; const { spawn } = Runtime;',
      ].map((code) => bannedUsage(code)),
      ...[
        'import { spawnSync as run } from "bun";',
        'import { $ } from "bun";',
        'import { default as Runtime } from "bun"; Runtime.$`git`;',
        'import * as Runtime from "bun"; Runtime.spawnSync(["git"]);',
        'const loaded = import("node:child_process");',
        "const loaded = import(`child_process`);",
      ].map((code) => ({ code, errors: [{ messageId: "bannedEvenWhenGranted" }] })),
    ],
  }),
);

export const runtimeModuleImportsCountForEveryPermissionBan = Task.make(
  "bun and node:process imports are refused for config, exit and SQL like the global members",
  ruleTest("no-config-reads", {
    valid: ['import { cwd } from "node:process";', 'import { Glob } from "bun";'],
    invalid: [
      { code: 'import { env } from "bun";', errors: [{ messageId: "bannedEvenWhenGranted" }] },
      ...[
        'import { env } from "node:process";',
        'import { env } from "process";',
        'import processModule from "node:process"; processModule.env.HOME;',
        'import * as processModule from "node:process"; processModule.env;',
      ].map((code) => bannedUsage(code)),
    ],
  }),
);

export const reExportsAreLeftToNoReExports = Task.make(
  "re-exports of banned modules and names, Node built-ins included, are left to no-re-exports, which reports every re-export, so the site is reported once",
  Effect.all(
    [
      ruleTest("no-command-spawn", {
        valid: [
          'export { Glob } from "bun";',
          'export type * from "bun";',
          'export { spawn } from "node:child_process";',
          'export * from "node:child_process";',
          'export * as childProcess from "node:child_process";',
          'export { spawn as run } from "bun";',
          'export * from "bun";',
          'export { default as Runtime } from "bun";',
        ],
        invalid: [],
      }),
      ruleTest("no-process-exit", {
        valid: [
          'export { exit } from "node:process";',
          'export * as processModule from "node:process";',
          'export { default as processModule } from "node:process";',
        ],
        invalid: [],
      }),
      ruleTest("no-sql-clients", {
        valid: [
          'export { SQL } from "bun";',
          'export * from "bun:sqlite";',
          'export { SqlClient } from "./cache-sqlite.ts";',
        ],
        invalid: [],
      }),
      ruleTest("no-node-path", {
        valid: [
          'export type { ParsedPath } from "node:path";',
          'export { join } from "node:path";',
          'export * as path from "node:path";',
        ],
        invalid: [],
      }),
      ruleTest("no-node-os", { valid: ['export * from "node:os";'], invalid: [] }),
    ],
    { discard: true },
  ),
);
