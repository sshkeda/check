import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const notConstantCase = (name: string) => ({
  message: `const ${name} is not in CAPITAL_SNAKE_CASE`,
});

const missingAsConst = (name: string) => ({
  message: `const ${name} does not end in as const`,
});

const annotated = (name: string) => ({ message: `const ${name} has a type annotation` });

export const fixedModuleValuesUseConstantCase = Task.make(
  "no-loose-literal-constants rejects module constants bound to fixed literals that are not CAPITAL_SNAKE_CASE",
  ruleTest("no-loose-literal-constants", {
    valid: [
      "const WORKER_STOP_TIMEOUT = 5000;",
      'export const PACKAGE_NAME = "@sshkeda/check";',
      "const RETRIES_2 = 2;",
      'const LIMITS = { retries: 3, names: ["a"] } as const;',
      "const OFFSETS = [-1, 1] as const satisfies ReadonlyArray<number>;",
      'import { Context, Effect, Layer, Schema } from "effect"; const workerPool = Effect.succeed(1); const Payload = Schema.Struct({}); const live = Layer.empty;',
      "const run = () => 1;",
      "const handler = function () {};",
      "class Store {}",
      "const Store = class {};",
      `const label = \`worker \${id}\`;`,
      "const now = Date.now();",
      "const pattern = /a/;",
      "const { timeout } = { timeout: 1 };",
      "let timeout = 1;",
      "function run() { const timeout = 1; return timeout; }",
      "const settings = { retries: count } as const;",
      "const settings = { run() {} } as const;",
      "const settings = { ...defaults } as const;",
    ],
    invalid: [
      { code: "const workerStopTimeout = 5000;", errors: [notConstantCase("workerStopTimeout")] },
      {
        code: 'export const packageName = "@sshkeda/check";',
        errors: [notConstantCase("packageName")],
      },
      { code: "const verbose = true;", errors: [notConstantCase("verbose")] },
      { code: "const offset = -1;", errors: [notConstantCase("offset")] },
      { code: "const big = 10n;", errors: [notConstantCase("big")] },
      { code: "const greeting = `hello`;", errors: [notConstantCase("greeting")] },
      {
        code: 'const limits = { retries: 3, names: ["a"] } as const;',
        errors: [notConstantCase("limits")],
      },
      {
        code: "const offsets = [-1, 1] as const satisfies ReadonlyArray<number>;",
        errors: [notConstantCase("offsets")],
      },
      { code: 'const kind = "worker" as const;', errors: [notConstantCase("kind")] },
      { code: "const Timeout = 1;", errors: [notConstantCase("Timeout")] },
      { code: "const nothing = null;", errors: [notConstantCase("nothing")] },
      { code: "const missing = undefined;", errors: [notConstantCase("missing")] },
      { code: "const worker_stop_timeout = 1;", errors: [notConstantCase("worker_stop_timeout")] },
    ],
  }),
);

export const dataConstantsEndInAsConst = Task.make(
  "no-loose-literal-constants requires as const on module constants that hold only fixed array or object data, and leaves computed values, scalars and local constants alone",
  ruleTest("no-loose-literal-constants", {
    valid: [
      'const NAMES = ["a", "b"] as const;',
      "export const LIMITS = { retries: 3, offsets: [-1, 1] } as const;",
      'const KINDS = ["a", "b"] as const satisfies ReadonlyArray<string>;',
      "const EMPTY = [] as const;",
      "const ITEMS = [compute()];",
      "const SETTINGS = { retries: count };",
      "const SETTINGS = { run() {} };",
      "const SETTINGS = { ...DEFAULTS };",
      "const SETTINGS = { [KEY]: 1 };",
      "const PATTERNS = [/a/];",
      `const LABELS = [\`worker \${id}\`];`,
      "const NAMES = new Set(['a']);",
      "function run() { const names = ['a']; return names; }",
      "let names = ['a'];",
      'const NAMES = ["a"] as const; const run = (take: (names: Array<string>) => void) => take([...NAMES]);',
    ],
    invalid: [
      { code: 'const NAMES = ["a", "b"];', errors: [missingAsConst("NAMES")] },
      {
        code: "export const LIMITS = { retries: 3, verbose: true, big: 10n, offsets: [-1, 1] };",
        errors: [missingAsConst("LIMITS")],
      },
      { code: "const GREETINGS = [`hello`];", errors: [missingAsConst("GREETINGS")] },
      {
        code: 'const KINDS = ["a", "b"] satisfies ReadonlyArray<string>;',
        errors: [missingAsConst("KINDS")],
      },
      { code: "const EMPTY = [];", errors: [missingAsConst("EMPTY")] },
      { code: "const OPTIONS = {};", errors: [missingAsConst("OPTIONS")] },
      { code: "const NOTHING = { value: null };", errors: [missingAsConst("NOTHING")] },
      { code: "const GAPS = [undefined, 1];", errors: [missingAsConst("GAPS")] },
      { code: 'const NESTED = { inner: { names: ["a"] } };', errors: [missingAsConst("NESTED")] },
    ],
  }),
);

export const literalConstantsUseSatisfies = Task.make(
  "no-loose-literal-constants reports a type annotation on an object or array literal constant at any scope, except an empty mutable accumulator annotated Array, T[], Record or an object type literal",
  ruleTest("no-loose-literal-constants", {
    valid: [
      "const LIMITS = { retries: 3 } as const satisfies Readonly<Record<string, number>>;",
      "const items: Array<string> = [];",
      "const items: string[] = [];",
      "const lookup: Record<string, number> = {};",
      "const lookup: { [key: string]: number } = {};",
      "const run = () => { const items: Array<string> = []; return items; };",
      "let limits: Limits = { retries: 3 };",
      "const limit: number = compute();",
    ],
    invalid: [
      {
        code: "const settings = () => { const names: Names = ['a']; return names; };",
        errors: [annotated("names")],
      },
      { code: "const SETTINGS: Settings = { retries: count };", errors: [annotated("SETTINGS")] },
      {
        code: "const EMPTY: ReadonlyArray<string> = [];",
        errors: [{ message: "const EMPTY has a type annotation and does not end in as const" }],
      },
      {
        code: "const EMPTY: readonly string[] = [];",
        errors: [{ message: "const EMPTY has a type annotation and does not end in as const" }],
      },
      {
        code: "const EMPTY: Readonly<Record<string, number>> = {};",
        errors: [{ message: "const EMPTY has a type annotation and does not end in as const" }],
      },
      {
        code: "const EMPTY: Array<string> = [] as const;",
        errors: [{ message: "const EMPTY has a type annotation" }],
      },
      {
        code: "const run = () => { const none: ReadonlyArray<string> = []; return none; };",
        errors: [annotated("none")],
      },
    ],
  }),
);

export const eachLooseConstantIsReportedOnce = Task.make(
  "a constant that breaks several literal rules gets one report naming every fix",
  ruleTest("no-loose-literal-constants", {
    valid: [],
    invalid: [
      {
        code: "const lookup: Readonly<Record<string, number>> = { a: 1 };",
        errors: [
          {
            message:
              "const lookup has a type annotation, is not in CAPITAL_SNAKE_CASE and does not end in as const",
          },
        ],
      },
      {
        code: "const names = ['a'];",
        errors: [
          { message: "const names is not in CAPITAL_SNAKE_CASE and does not end in as const" },
        ],
      },
      {
        code: "const NAMES: ReadonlyArray<string> = ['a', 'b'];",
        errors: [{ message: "const NAMES has a type annotation and does not end in as const" }],
      },
    ],
  }),
);
