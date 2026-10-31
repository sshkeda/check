import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const vague = (code: string, name: string) => ({
  code,
  filename: "src/source.ts",
  errors: [{ messageId: "vague", data: { name } }],
});

export const rejectsVagueErrorClassNames = Task.make(
  "no-vague-error-names rejects a class that extends another and is named only with Failure, Error, Invalid, Unknown and Refused",
  ruleTest("no-vague-error-names", {
    valid: [
      'import { Schema } from "effect";\nexport class ReleaseRefused extends Schema.TaggedError<ReleaseRefused>()("ReleaseRefused", {}) {}',
      "export class Unknown {}",
      "export class TaskCrashed extends Error {}",
      "export const Anonymous = class extends Error {};",
    ].map((code) => ({ code, filename: "src/source.ts" })),
    invalid: [
      vague(
        'import { Schema } from "effect";\nexport class Failure extends Schema.TaggedError<Failure>()("Failure", {}) {}',
        "Failure",
      ),
      vague("export class InvalidError extends Error {}", "InvalidError"),
      vague("export const Named = class Refused extends Error {};", "Refused"),
    ],
  }),
);
