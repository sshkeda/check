import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const flagged = (name: string, fullWords: string, abbreviations = "an abbreviation") => ({
  messageId: "abbreviation",
  data: { name, fullWords, abbreviations },
});

export const expandsAbbreviationsAcrossNamingStyles = Task.make(
  "no-abbreviations names the full word in camelCase, PascalCase and snake_case",
  ruleTest("no-abbreviations", {
    valid: [
      "const message = 'hi';",
      "const userId = 1;",
      "const htmlUrl = 'a';",
      "const parseJsonHttp = (sqlText: string) => sqlText;",
      "const MAX_RETRIES = 3;",
      "const config = defineConfig({});",
      "const execution = 1;",
      "const exec = () => 1;",
      "const execOptions = {};",
      "class ExecFailed {}",
      "const strings = [''];",
    ],
    invalid: [
      { code: "const msg = 'hi';", errors: [flagged("msg", "message")] },
      {
        code: "const exprOptions = {};",
        errors: [flagged("exprOptions", "expression")],
      },
      {
        code: "const MAX_LEN = 3;",
        errors: [flagged("MAX_LEN", "length")],
      },
      {
        code: "const tmp_dir = '/tmp';",
        errors: [flagged("tmp_dir", "temporary and directory", "abbreviations")],
      },
      {
        code: "const prevCwd = '.';",
        errors: [flagged("prevCwd", "previous and working directory", "abbreviations")],
      },
      {
        code: "const confPath = '';",
        errors: [flagged("confPath", "config")],
      },
      {
        code: "const CFG_FILE = '';",
        errors: [flagged("CFG_FILE", "config")],
      },
      {
        code: "const outputDir = '';",
        errors: [flagged("outputDir", "directory")],
      },
      {
        code: "const dirs = [];",
        errors: [flagged("dirs", "directories")],
      },
      {
        code: "const fs = yield* FileSystem.FileSystem;",
        errors: [flagged("fs", "file system")],
      },
      {
        code: "const call = (fn: () => void) => fn();",
        errors: [flagged("fn", "function")],
      },
      {
        code: "const commandArgs = [];",
        errors: [flagged("commandArgs", "arguments")],
      },
    ],
  }),
);

export const checksOnlyDeclaredNames = Task.make(
  "no-abbreviations flags every name a file declares and none it only uses",
  ruleTest("no-abbreviations", {
    valid: [
      "process.env.HOME;",
      "child.stdout.pipe(sink);",
      "spawn('git', [], { cwd: root, env: environment });",
      "import { exec } from 'node:child_process';",
      "export { exec } from './run.ts';",
      "class Failed extends Error { override get msg() { return ''; } }",
      "const options = { opts: true, fn() {} };",
      "type Options = { [key: string]: number };",
    ],
    invalid: [
      { code: "function run(cb) {}", errors: [flagged("cb", "callback")] },
      {
        code: "const run = ({ cwd }, [first, ...rest]) => cwd;",
        errors: [flagged("cwd", "working directory")],
      },
      {
        code: "for (const idx of indices) {}",
        errors: [flagged("idx", "index")],
      },
      {
        code: "try {} catch (err) {}",
        errors: [flagged("err", "error")],
      },
      {
        code: "type Opts = { readonly env: string; run(ctx: string): void };",
        errors: [
          flagged("Opts", "options"),
          flagged("env", "environment"),
          flagged("ctx", "context"),
        ],
      },
      {
        code: "interface Req { readonly src: string }",
        errors: [flagged("Req", "request"), flagged("src", "source")],
      },
      {
        code: "class Store { #obj = 1; getVal() { return this.#obj; } }",
        errors: [flagged("obj", "object"), flagged("getVal", "value")],
      },
      {
        code: "class Store { accessor db = 1; }",
        errors: [flagged("db", "database")],
      },
      {
        code: "import * as utils from './utils.ts';",
        errors: [flagged("utils", "utilities")],
      },
      {
        code: "import { readFile as readStr } from 'node:fs';",
        errors: [flagged("readStr", "string")],
      },
      {
        code: "const readConfig = () => 1; export { readConfig as readCfg };",
        errors: [flagged("readCfg", "config")],
      },
      {
        code: "export { readFile as readStr } from 'node:fs';",
        errors: [flagged("readStr", "string")],
      },
      {
        code: "export * as utils from './utilities.ts';",
        errors: [flagged("utils", "utilities")],
      },
      {
        code: "const pick = <Val,>(value: Val) => value;",
        errors: [flagged("Val", "value")],
      },
      {
        code: "enum Kind { Btn }",
        errors: [flagged("Btn", "button")],
      },
      {
        code: "type Run = (cfg: string) => void;",
        errors: [flagged("cfg", "config")],
      },
    ],
  }),
);

export const namesTheFullWordOnce = Task.make(
  "no-abbreviations names the full word without repeating the abbreviated name",
  ruleTest("no-abbreviations", {
    valid: [],
    invalid: [
      {
        code: "const cnt = 0;",
        errors: [{ message: "`cnt` contains an abbreviation of count" }],
      },
      {
        code: "const prevCwd = '.';",
        errors: [
          {
            message: "`prevCwd` contains abbreviations of previous and working directory",
          },
        ],
      },
      {
        code: "const exprOptions = {};",
        errors: [{ message: "`exprOptions` contains an abbreviation of expression" }],
      },
      {
        code: "const args = [];",
        errors: [
          {
            message: "`args` contains an abbreviation of arguments",
          },
        ],
      },
    ],
  }),
);

export const respectsConfiguredAllowedWords = Task.make(
  "no-abbreviations takes an allow list for a repo's own terms",
  ruleTest("no-abbreviations", {
    valid: [{ code: "const rect = box();", options: [{ allow: ["rect"] }] }],
    invalid: [
      {
        code: "const rect = box(); const pt = 1;",
        options: [{ allow: ["rect"] }],
        errors: [flagged("pt", "point")],
      },
    ],
  }),
);
