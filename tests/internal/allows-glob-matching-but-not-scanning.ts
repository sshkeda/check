import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const allowsGlobMatchingButNotScanning = Task.make(
  "no-glob-scan allows Bun.Glob string matching and rejects directory scanning, and finishes on a variable initialized from itself",
  ruleTest("no-glob-scan", {
    valid: [
      'new Bun.Glob("**/*.ts").match("src/index.ts");',
      'const pattern = new Bun.Glob("**/*.ts"); pattern.match("src/index.ts");',
      'import { Glob } from "bun"; new Glob("*.ts").match("a.ts");',
      'const Bun = { Glob: class { scan() {} } }; new Bun.Glob("*").scan();',
      "class Glob { scan() {} } new Glob().scan();",
      'import { Glob } from "other"; new Glob("*").scan();',
      "const reader = { scan: () => [] }; reader.scan();",
      'import { FileSystem } from "effect"; FileSystem.glob;',
      "const glob = glob; glob.scan();",
      "const first = second; const second = first; first.scan();",
    ],
    invalid: [
      'new Bun.Glob("**/*.ts").scan(".");',
      'new Bun.Glob("**/*.ts").scanSync(".");',
      'const pattern = new Bun.Glob("**/*.ts"); pattern.scan(".");',
      'import { Glob } from "bun"; const pattern = new Glob("*.ts"); pattern.scanSync(".");',
      'import { Glob as Matcher } from "bun"; new Matcher("*.ts").scan(".");',
      'import * as BunModule from "bun"; new BunModule.Glob("*.ts").scan(".");',
      'import BunDefault from "bun"; new BunDefault.Glob("*.ts").scan(".");',
      'new Bun.Glob("*.ts")["scan"](".");',
    ].map((code) => ({ code, errors: [{ messageId: "scan" }] })),
  }),
);
