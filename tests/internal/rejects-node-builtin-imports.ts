import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const BUILTIN_VALID = [
  'import { Effect } from "effect";',
  'import type { Stats } from "node:fs";',
  'import { type Stats } from "node:fs";',
  'import { Worker } from "node:worker_threads";',
  'import { readFileSync } from "node:fs";',
  'import { readFile } from "fs/promises";',
  'import path = require("node:path");',
  'export { join } from "node:path";',
  'export * from "node:path";',
  'const loaded = import("node:fs");',
  "const load = (specifier) => import(specifier);",
] as const;

const builtinTest = (rule: string, invalid: readonly string[]) =>
  ruleTest(rule, {
    valid: BUILTIN_VALID,
    invalid: invalid.map((code) => ({ code, errors: [{ messageId: "builtin" }] })),
  });

export const rejectsNodeBuiltins = Task.make({
  name: "each Node built-in with an Effect replacement has its own rule, which also owns a literal import() of it, while import = stays with no-require-imports and re-exports with no-re-exports",
  run: Effect.all(
    [
      builtinTest("no-node-path", [
        'import * as path from "node:path";',
        'const loaded = import("node:path");',
        'const loaded = import("path/posix");',
        'import { join } from "bun:path";',
        'import { posix } from "bun:path/posix";',
      ]),
      builtinTest("no-node-crypto", [
        'import { createHash } from "node:crypto";',
        'import { createHash } from "bun:crypto";',
      ]),
      builtinTest("no-node-os", ['import { tmpdir } from "node:os";']),
      builtinTest("no-node-timers", [
        'import { setTimeout } from "node:timers/promises";',
        'import { performance } from "node:perf_hooks";',
      ]),
      builtinTest("no-node-http", ['import { request } from "node:https";']),
      builtinTest("no-node-stream", ['import { Readable } from "node:stream";']),
    ],
    { discard: true },
  ),
});

const GRANTED = [{ bans: "onlyThoseNoGrantLifts" }] as const;

export const nodeFileSystemStaysInNodeFileSystemFiles = Task.make({
  name: "no-node-file-system allows open from node:fs/promises and constants from node:fs only in files granted locksFiles, bans the rest of node:fs and node:fs/promises in every file, and leaves synchronous file access to no-sync-file-access",
  run: ruleTest("no-node-file-system", {
    valid: [
      'import { Effect } from "effect";',
      'import type { Stats } from "node:fs";',
      'import { type Stats } from "bun:fs";',
      'import { join } from "node:path";',
      'import { appendFileSync } from "node:fs";',
      'import { closeSync, fsyncSync, openSync, writeSync } from "fs";',
      'import { readFileSync } from "bun:fs";',
      'import { existsSync, statSync } from "fs";',
      'export { stat } from "node:fs/promises";',
      'export * from "node:fs";',
      ...[
        'import { open } from "node:fs/promises";',
        'import { constants, readFileSync } from "node:fs";',
      ].map((code) => ({ code, options: GRANTED })),
    ],
    invalid: [
      ...[
        'import { open } from "node:fs/promises";',
        'import { constants } from "node:fs";',
        'import { constants, readFileSync } from "node:fs";',
      ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
      ...[
        'import { stat } from "node:fs/promises";',
        'import { readFile } from "fs/promises";',
        'import { watch } from "node:fs";',
        'import { open } from "node:fs";',
        'import { promises } from "node:fs";',
        'import { appendFileSync, readFileSync, watch } from "node:fs";',
        'import * as fs from "node:fs";',
        'import fs from "fs";',
        'import "node:fs";',
        'const loaded = import("node:fs");',
      ].flatMap((code) => [
        { code, errors: [{ messageId: "bannedEvenWhenGranted" }] },
        { code, options: GRANTED, errors: [{ messageId: "bannedEvenWhenGranted" }] },
      ]),
    ],
  }),
});

export const rejectsSyncFileAccessEverywhere = Task.make({
  name: "no-sync-file-access rejects synchronous reads and writes imported from any module, read from a default or namespace import, or called on any receiver",
  run: ruleTest("no-sync-file-access", {
    valid: [
      'import { readFile } from "node:fs/promises";',
      'import type { writeFileSync, readFileSync } from "node:fs";',
      "function writeFileSync() {} writeFileSync();",
      "function readFileSync() {} readFileSync();",
      'export { openSync, readdirSync } from "node:fs";',
    ],
    invalid: [
      'import { appendFileSync } from "node:fs";',
      'import { writeFileSync as write } from "fs";',
      'import * as fs from "node:fs"; fs.writeFileSync("a", "b");',
      'import fs from "node:fs"; fs.writeFileSync("a", "b");',
      'import { default as fs } from "fs"; fs.appendFileSync("a", "b");',
      'import { writeFileSync } from "fs-extra";',
      'import fsExtra from "fs-extra"; fsExtra.writeFileSync("a", "b");',
      "const { writeFileSync } = fileSystem;",
      'import fs from "node:fs"; const { "writeFileSync": write } = fs;',
      'receiver.writeFileSync("a", "b");',
      'import { readFileSync } from "node:fs";',
      'import { existsSync as exists } from "fs";',
      'import * as fs from "node:fs"; fs.statSync("a");',
      'import fs from "node:fs"; fs.existsSync("a");',
      'import { default as fs } from "fs"; fs.readFileSync("a");',
      'import { readFileSync } from "fs-extra";',
      'import fsExtra from "fs-extra"; fsExtra.statSync("a");',
      'import * as fsExtra from "fs-extra"; fsExtra.existsSync("a");',
      "const { readFileSync } = fileSystem;",
      'receiver.readFileSync("a");',
      'import fs from "node:fs"; const { "statSync": stat } = fs;',
      'const { "existsSync": exists } = receiver;',
    ].map((code) => ({ code, errors: [{ messageId: "banned" }] })),
  }),
});

const GRANTED_OPTIONS = [{ bans: "onlyThoseNoGrantLifts" }] as const;

const aliasesOf = (name: string) => [`node:${name}`, name, `bun:${name}`];

const everyAlias = (
  rule: string,
  cases: { readonly banned: readonly string[]; readonly bannedEvenWhenGranted: readonly string[] },
) =>
  ruleTest(rule, {
    valid: cases.banned.map((code) => ({ code, options: GRANTED_OPTIONS })),
    invalid: [
      ...cases.banned.map((code) => ({ code, errors: [{ messageId: "banned" }] })),
      ...cases.bannedEvenWhenGranted.flatMap((code) => [
        { code, errors: [{ messageId: "bannedEvenWhenGranted" }] },
        { code, options: GRANTED_OPTIONS, errors: [{ messageId: "bannedEvenWhenGranted" }] },
      ]),
    ],
  });

export const everyAliasOfANodeBuiltinIsBannedLikeIt = Task.make({
  name: "every alias of a Node built-in a permission bans, node:X, bare X and Bun's bun:X, is banned exactly like node:X, and bun:sqlite stays Bun's own SQLite client",
  run: Effect.all(
    [
      everyAlias("no-node-file-system", {
        banned: [
          ...aliasesOf("fs/promises").map((module) => `import { open } from "${module}";`),
          ...aliasesOf("fs").map((module) => `import { constants } from "${module}";`),
        ],
        bannedEvenWhenGranted: [
          ...aliasesOf("fs/promises").map((module) => `import { stat } from "${module}";`),
          ...aliasesOf("fs").map((module) => `import { watch } from "${module}";`),
          ...aliasesOf("fs").map((module) => `import { open } from "${module}";`),
          ...aliasesOf("fs").map((module) => `import * as fileSystem from "${module}";`),
        ],
      }),
      everyAlias("no-command-spawn", {
        banned: aliasesOf("child_process").map((module) => `import { spawn } from "${module}";`),
        bannedEvenWhenGranted: aliasesOf("child_process").map(
          (module) => `import { execSync } from "${module}";`,
        ),
      }),
      everyAlias("no-dynamic-import", {
        banned: aliasesOf("module").map((module) => `import { createRequire } from "${module}";`),
        bannedEvenWhenGranted: aliasesOf("vm").map(
          (module) => `import { Script } from "${module}";`,
        ),
      }),
      everyAlias("no-config-reads", {
        banned: aliasesOf("process").map((module) => `import { env } from "${module}";`),
        bannedEvenWhenGranted: aliasesOf("util").map(
          (module) => `import { parseArgs } from "${module}";`,
        ),
      }),
      everyAlias("no-terminal-writes", {
        banned: [],
        bannedEvenWhenGranted: aliasesOf("process").map(
          (module) => `import { stdout } from "${module}";`,
        ),
      }),
      everyAlias("no-sql-clients", {
        banned: [],
        bannedEvenWhenGranted: [
          ...aliasesOf("sqlite").map((module) => `import { DatabaseSync } from "${module}";`),
          'import { Database } from "bun:sqlite";',
        ],
      }),
      ruleTest("no-sync-file-access", {
        valid: [],
        invalid: aliasesOf("fs").map((module) => ({
          code: `import { readFileSync } from "${module}";`,
          errors: [{ messageId: "banned" }],
        })),
      }),
    ],
    { discard: true },
  ),
});
