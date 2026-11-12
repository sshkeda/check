import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const everyVariableIsConst = Task.make({
  name: "no-let reports every let, for...of and for...in headers included, leaves the let that starts a for statement to no-while, and names the bindings it declares without their types",
  run: ruleTest("no-let", {
    valid: [
      "const total = 1;",
      "for (const item of items) {}",
      "for (const [index, item] of items.entries()) {}",
      "for (const key in record) {}",
      "for (let index = 0; index < 3; index += 1) {}",
    ],
    invalid: [
      {
        code: "let total = 0;",
        errors: [{ message: "let declares total, which can be reassigned" }],
      },
      {
        code: "let first = 1, second = 2;",
        errors: [{ message: "let declares first, second, which can be reassigned" }],
      },
      {
        code: "for (let item of items) {}",
        errors: [{ message: "let declares item, which can be reassigned" }],
      },
      {
        code: "let { size, ...rest } = box;",
        errors: [{ message: "let declares size, rest, which can be reassigned" }],
      },
      {
        code: "let count: number = 0, [first = 1, , ...others]: Array<number> = [];",
        errors: [{ message: "let declares count, first, others, which can be reassigned" }],
      },
    ],
  }),
});

export const mutableRefIsBanned = Task.make({
  name: "no-mutable-ref reports MutableRef from effect however it is imported, and leaves Ref, types and local names alone",
  run: ruleTest("no-mutable-ref", {
    valid: [
      'import { Ref } from "effect"; const counter = Ref.make(0);',
      'import type { MutableRef } from "effect"; type Counter = MutableRef.MutableRef<number>;',
      "const MutableRef = { make: (value: number) => value }; MutableRef.make(0);",
    ],
    invalid: [
      {
        code: 'import { MutableRef } from "effect"; const counter = MutableRef.make(0);',
        errors: [{ message: "MutableRef.make keeps a reassignable value in a synchronous box" }],
      },
      {
        code: 'import * as MutableRef from "effect/MutableRef"; MutableRef.set(counter, 1);',
        errors: [{ message: "MutableRef.set keeps a reassignable value in a synchronous box" }],
      },
      {
        code: 'import { make } from "effect/MutableRef"; make(0);',
        errors: [{ message: "MutableRef.make keeps a reassignable value in a synchronous box" }],
      },
    ],
  }),
});
