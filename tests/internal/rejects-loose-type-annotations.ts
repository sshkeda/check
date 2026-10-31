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
