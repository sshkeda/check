import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const unknownStaysOutOfSignatures = Task.make(
  "no-unknown-boundaries rejects unknown parameters and exported unknown returns, and leaves type aliases to no-type-declarations",
  ruleTest("no-unknown-boundaries", {
    valid: [
      "const run = (value: string) => value;",
      'import { Schema } from "effect"; const read = (input: unknown) => Schema.decodeUnknownSync(Payload)(input);',
      'import { Schema } from "effect"; const isPayload = (input: unknown) => Schema.is(Payload)(input);',
      'import { Effect } from "effect"; Effect.tryPromise({ try: load, catch: (cause: unknown) => new LoadFailed({ cause }) });',
      "promise.catch((cause: unknown) => cause);",
      "const read = (): unknown => 1;",
      "type Payload = { readonly value: unknown };",
      "type Payload = unknown;",
      "const values: ReadonlyArray<unknown> = [];",
    ],
    invalid: [
      { code: "const run = (value: unknown) => value;", errors: [{ messageId: "parameter" }] },
      { code: "function run(value: unknown) {}", errors: [{ messageId: "parameter" }] },
      {
        code: "class Store { constructor(value: unknown) {} }",
        errors: [{ messageId: "parameter" }],
      },
      {
        code: 'import { Schema } from "effect"; const read = (input: unknown) => [input, Schema.decodeUnknownSync(Payload)(input)];',
        errors: [{ messageId: "parameter" }],
      },
      {
        code: "const handle = (cause: unknown) => cause;",
        errors: [{ messageId: "parameter" }],
      },
      { code: "export const read = (): unknown => 1;", errors: [{ messageId: "returnType" }] },
      { code: "function read(): unknown { return 1; }", errors: [{ messageId: "returnType" }] },
      { code: "declare function read(): unknown;", errors: [{ messageId: "returnType" }] },
    ],
  }),
);

export const exportedMembersKeepUnknownOutOfTheirReturns = Task.make(
  "no-unknown-boundaries rejects unknown returns of methods and function members of exported classes and objects, naming the member, while private members and members of unexported classes and objects pass",
  ruleTest("no-unknown-boundaries", {
    valid: [
      "class Store { read(): unknown { return 1; } }",
      "export class Store { private read(): unknown { return 1; } }",
      "export class Store { #read(): unknown { return 1; } }",
      "const STORE = { read(): unknown { return 1; } };",
      "export const STORE = { read(): string { return 'a'; } };",
    ],
    invalid: [
      ["export class Store { read(): unknown { return 1; } }", "read"],
      ["export default class { get value(): unknown { return 1; } }", "value"],
      ["export class Store { load = (): unknown => 1; }", "load"],
      ["export const Store = class { read(): unknown { return 1; } };", "read"],
      ["export const STORE = { read(): unknown { return 1; } };", "read"],
      ["export const STORE = { load: (): unknown => 1 };", "load"],
      ["export default { 'load-all': function (): unknown { return 1; } };", "load-all"],
    ].map(([code = "", name = ""]) => ({
      code,
      errors: [{ messageId: "returnType", data: { name } }],
    })),
  }),
);
