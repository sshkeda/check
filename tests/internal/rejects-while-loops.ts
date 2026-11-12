import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const whileLoopsAreBanned = Task.make({
  name: "no-while reports while, do...while and every for statement, and leaves for...of, for...in, for await...of and loops inside template strings alone",
  run: ruleTest("no-while", {
    valid: [
      "for (const item of items) {}",
      "for (const key in record) {}",
      "async function run() { for await (const item of items) {} }",
      "const source = `while (true) {} do {} while (true); for (;;) {}`;",
    ],
    invalid: [
      {
        code: "while (pending.length > 0) {}",
        errors: [
          { message: "while loops on a condition or counter that outside state must change" },
        ],
      },
      {
        code: "do {} while (pending.length > 0);",
        errors: [
          { message: "do...while loops on a condition or counter that outside state must change" },
        ],
      },
      {
        code: "for (;;) {}",
        errors: [{ message: "for loops on a condition or counter that outside state must change" }],
      },
      {
        code: "for (const start = 0; ; ) {}",
        errors: [{ message: "for loops on a condition or counter that outside state must change" }],
      },
      {
        code: "for (; pending.length > 0; ) {}",
        errors: [{ message: "for loops on a condition or counter that outside state must change" }],
      },
      {
        code: "for (;true;) {}",
        errors: [{ message: "for loops on a condition or counter that outside state must change" }],
      },
      {
        code: "for (const index = 0; index < 3; ) {}",
        errors: [{ message: "for loops on a condition or counter that outside state must change" }],
      },
    ],
  }),
});
