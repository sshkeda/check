import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const ASSERTING_SOURCES = [
  'import { expect as check } from "bun:test";',
  'import { describe, expect } from "bun:test";',
  'import assert from "node:assert";',
  'import { strictEqual } from "node:assert/strict";',
  'import * as assert from "assert";',
  'import { deepEqual } from "assert/strict";',
] as const;

export const refusesAssertions = Task.make({
  name: "no-assertions refuses bun:test expect and node:assert outside tests/, and leaves import {} to no-import-type-side-effects and re-exports to no-re-exports",
  run: ruleTest("no-assertions", {
    valid: [
      'import type { AssertionError } from "node:assert";',
      'import { type Expect } from "bun:test";',
      'import { describe } from "bun:test";',
      'import { Effect } from "effect";',
      'import {} from "node:assert";',
      'export { expect } from "bun:test";',
      'export { ok } from "node:assert";',
      'export * from "node:assert";',
    ],
    invalid: [
      {
        code: 'import { expect } from "bun:test";',
        errors: [
          {
            message: "asserts with expect from bun:test outside tests/",
          },
        ],
      },
      {
        code: 'import assert from "node:assert/strict";\nassert.ok(true);',
        errors: [
          {
            message: "asserts with node:assert/strict outside tests/",
          },
        ],
      },
      ...ASSERTING_SOURCES.map((code) => ({ code, errors: [{ messageId: "assertion" }] })),
    ],
  }),
});

export const refusesTestRunners = Task.make({
  name: "no-test-runners refuses test runner modules, every bun:test value but expect, and a side-effect import of bun:test, in tests/ too, while import {}, re-exports and import = of bun:test stay with the rules that own them",
  run: ruleTest("no-test-runners", {
    valid: [
      'import { expect } from "bun:test";',
      'import { type Mock, expect as check } from "bun:test";',
      'import type { Mock } from "vitest";',
      'import { Effect } from "effect";',
      'import {} from "bun:test";',
      'import {} from "vitest";',
      'export * from "bun:test";',
      'export { test } from "bun:test";',
      'export * from "vitest";',
      'import runner = require("bun:test");',
    ],
    invalid: [
      [
        'import { describe, expect as check, test } from "bun:test";',
        "describe, test from bun:test",
      ],
      ['import { describe as group } from "vitest";', "a test runner from vitest"],
      ['import { jest } from "@jest/globals";', "a test runner from @jest/globals"],
      ['import { it } from "jest";', "a test runner from jest"],
      ['import { bench } from "vitest/node";', "a test runner from vitest/node"],
      ['import { type Mock, mock, spyOn } from "bun:test";', "mock, spyOn from bun:test"],
      ['import * as Bun from "bun:test";', "Bun from bun:test"],
      ['import "bun:test";', "a test runner from bun:test"],
    ].map(([code = "", imported]) => ({
      code,
      filename: "tests/shared/cache.ts",
      errors: [{ message: `imports ${imported}` }],
    })),
  }),
});
