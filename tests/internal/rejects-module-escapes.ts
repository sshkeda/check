import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { oxlintBinary } from "../shared/oxlint-binary.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const lintOutput = (source: string) =>
  Effect.gen(function* () {
    const { directory } = yield* makeProject({ "main.ts": source });
    return yield* Task.exec(
      "bun",
      [yield* oxlintBinary, "--config", "oxlint.config.ts", "--format", "agent", "main.ts"],
      {
        cwd: directory,
      },
    ).pipe(
      Effect.as(""),
      Effect.catchTag("CommandFailed", (failure) =>
        Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
      ),
    );
  }).pipe(Effect.scoped);

export const requireFormsAreRefused = Task.make(
  "import = require, require() and import.meta.require cannot reach banned modules",
  Effect.gen(function* () {
    const output = yield* lintOutput(`import childProcess = require("node:child_process");
const fileSystem = require("node:fs");
export const loaded = [childProcess, fileSystem, import.meta.require("bun")];
`);
    expect(output).toContain("main.ts:1:1: error typescript(no-require-imports)");
    expect(output).toContain("main.ts:2:20: error typescript(no-require-imports)");
    expect(output).toContain(
      "main.ts:3:50: error sshkeda(no-dynamic-import): import.meta.require loads code in a way no file may",
    );
  }),
);

export const importMetaRequireNeedsDynamicImports = Task.make(
  "import.meta.require is refused in every file, even one granted importsDynamically",
  ruleTest("no-dynamic-import", {
    valid: ["import.meta.url;", "import.meta.resolve;"],
    invalid: ['import.meta.require("node:fs");', 'import.meta["require"]("bun");'].flatMap(
      (code) => [
        { code, errors: [{ messageId: "bannedEvenWhenGranted" }] },
        {
          code,
          options: [{ bans: "onlyThoseNoGrantLifts" }],
          errors: [{ messageId: "bannedEvenWhenGranted" }],
        },
      ],
    ),
  }),
);

export const selfIsRefusedLikeGlobalThis = Task.make(
  "self is refused like globalThis, so self.Bun and self.process reach nothing, and a shorthand { self } is reported once",
  Effect.gen(function* () {
    const output = yield* lintOutput(`export const spawned = () => self.Bun.spawn(["git"]);
export const home = self.process.env.HOME;
export const shorthand = { self };
`);
    expect(output).toContain("main.ts:1:30: error sshkeda(no-global-object): global self is used");
    expect(output).toContain("main.ts:2:21: error sshkeda(no-global-object): global self is used");
    expect(output.match(/main\.ts:3:\d+: error sshkeda\(no-global-object\)/gu)?.length).toBe(1);
  }),
);
