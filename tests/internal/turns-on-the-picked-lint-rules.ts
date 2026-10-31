import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Schema } from "effect";

import { lintConfig } from "../../src/index.ts";
import { decodeRuleOptions } from "../../src/internal/describe-and-decode-rule-options.ts";
import { oxlintReport } from "../../src/lib/tasks/lib/lint-with-oxlint/internal/read-oxlint-json-report.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { lintErrorsOfEachCase } from "../shared/lint-errors-of-each-case.ts";

const PICKED_RULES = {
  "eslint/array-callback-return": "error",
  "eslint/arrow-body-style": "error",
  "eslint/class-methods-use-this": ["error", { ignoreOverrideMethods: true }],
  "eslint/func-style": "error",
  "eslint/id-length": "error",
  "eslint/no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
  "eslint/no-empty-function": ["error", { allow: ["privateConstructors"] }],
  "eslint/no-implicit-coercion": "error",
  "eslint/no-magic-numbers": ["error", { ignore: [0, 1, -1], ignoreTypeIndexes: true }],
  "eslint/no-regex-spaces": "error",
  "eslint/no-shadow": "error",
  "eslint/no-template-curly-in-string": "error",
  "eslint/no-unused-private-class-members": "error",
  "eslint/no-use-before-define": "error",
  "eslint/no-void": ["error", { allowAsStatement: true }],
  "eslint/prefer-named-capture-group": "error",
  "eslint/prefer-object-spread": "error",
  "eslint/prefer-regex-literals": "error",
  "eslint/prefer-template": "error",
  "eslint/require-unicode-regexp": "error",
  "typescript/array-type": "error",
  "typescript/dot-notation": "error",
  "typescript/explicit-member-accessibility": "error",
  "typescript/no-confusing-void-expression": "error",
  "typescript/no-dynamic-delete": "error",
  "typescript/no-misused-promises": "error",
  "typescript/no-unnecessary-boolean-literal-compare": "error",
  "typescript/parameter-properties": "error",
  "typescript/prefer-nullish-coalescing": "error",
  "typescript/prefer-optional-chain": "error",
  "typescript/prefer-promise-reject-errors": "error",
  "typescript/prefer-regexp-exec": "error",
  "typescript/prefer-string-starts-ends-with": "error",
  "sshkeda/no-unsorted-type-constituents": "error",
  "typescript/strict-boolean-expressions": "error",
  "typescript/strict-void-return": "error",
  "typescript/use-unknown-in-catch-callback-variable": "error",
  "unicorn/catch-error-name": "error",
  "unicorn/consistent-existence-index-check": "error",
  "unicorn/consistent-function-scoping": "error",
  "unicorn/escape-case": "error",
  "unicorn/explicit-length-check": "error",
  "unicorn/new-for-builtins": "error",
  "unicorn/no-array-callback-reference": "error",
  "unicorn/no-array-for-each": "error",
  "unicorn/no-array-reduce": "error",
  "unicorn/no-array-sort": "error",
  "unicorn/no-hex-escape": "error",
  "unicorn/no-immediate-mutation": "error",
  "unicorn/no-negated-condition": "error",
  "unicorn/numeric-separators-style": "error",
  "unicorn/prefer-add-event-listener": "error",
  "unicorn/prefer-array-index-of": "error",
  "unicorn/prefer-code-point": "error",
  "unicorn/prefer-negative-index": "error",
  "unicorn/prefer-number-properties": "error",
  "unicorn/prefer-single-call": "error",
  "unicorn/prefer-spread": "error",
  "unicorn/prefer-string-raw": "error",
  "unicorn/prefer-string-replace-all": "error",
  "unicorn/prefer-ternary": "error",
  "unicorn/relative-url-style": "error",
  "unicorn/switch-case-braces": "error",
  "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
  "import/newline-after-import": "error",
  "import/no-anonymous-default-export": "error",
  "import/no-unassigned-import": "error",
} as const;

const UNPICKED_RULES = ["unicorn/prefer-native-coercion-functions"] as const;

export const lintConfigTurnsOnThePickedRules = Task.make(
  "lintConfig turns on each picked rule at error with its options, and leaves off prefer-native-coercion-functions, which would demand .map(Number) where no-namespace-aliases refuses it",
  Effect.sync(() => {
    const { rules } = lintConfig({});
    expect(
      Object.fromEntries(Object.keys(PICKED_RULES).map((rule) => [rule, rules[rule]])),
    ).toEqual(PICKED_RULES);
    expect(UNPICKED_RULES.filter((rule) => rule in rules)).toEqual([]);
  }),
);

export const ruleOptionsRejectInvalidValues = Task.make(
  "rule options decode valid values and reject invalid and excess properties",
  Effect.sync(() => {
    const options = Schema.Struct({ name: Schema.String });
    expect(decodeRuleOptions(options, [])).toBeUndefined();
    expect(decodeRuleOptions(options, [{ name: "value" }])).toEqual({ name: "value" });
    expect(() => decodeRuleOptions(options, [{ name: 1 }])).toThrow(Schema.SchemaError);
    expect(() => decodeRuleOptions(options, [{ name: "value", extra: true }])).toThrow(
      Schema.SchemaError,
    );
  }),
);

const OPTION_RULE_TAGS = [
  "eslint(class-methods-use-this)",
  "eslint(no-duplicate-imports)",
  "eslint(no-empty-function)",
  "eslint(no-magic-numbers)",
  "eslint(no-use-before-define)",
  "eslint(no-void)",
  "import(consistent-type-specifier-style)",
  "typescript(no-invalid-void-type)",
] as const;

export const pickedOptionsDecideWhatIsReported = Task.make(
  "class-methods-use-this skips override methods, no-duplicate-imports allows a separate import type, consistent-type-specifier-style wants import type, no-use-before-define reports a use inside a function that runs later, no-void allows void as a statement only, no-empty-function allows an empty private constructor only, no-magic-numbers allows a number that indexes a type, and no-invalid-void-type stays off",
  Effect.gen(function* () {
    const cases = [
      [
        'export class Greeter {\n  public greet() {\n    return "hi";\n  }\n}',
        ["eslint(class-methods-use-this)"],
      ],
      [
        'class Named {\n  public name() {\n    return String(this);\n  }\n}\nexport class Guest extends Named {\n  public override name() {\n    return "guest";\n  }\n}',
        [],
      ],
      [
        'import type { Schema } from "effect";\nimport { Effect } from "effect";\n\nexport const USED: [typeof Effect, Schema.Top] | undefined = undefined;',
        [],
      ],
      [
        'import { Effect } from "effect";\nimport { Schema } from "effect";\n\nexport const USED = [Effect, Schema];',
        ["eslint(no-duplicate-imports)"],
      ],
      [
        'import { Effect, type Schema } from "effect";\n\nexport const USED: [typeof Effect, Schema.Top] | undefined = undefined;',
        ["import(consistent-type-specifier-style)"],
      ],
      [
        'export const greet = () => greeting;\nconst greeting = "hi";',
        ["eslint(no-use-before-define)"],
      ],
      ["export const start = (work: () => Promise<string>) => {\n  void work();\n};", []],
      ["export const NOTHING = void 0;", ["eslint(no-void)"]],
      ["export class Only {\n  private constructor() {}\n}", []],
      ["export const ignore = () => {};", ["eslint(no-empty-function)"]],
      ["export const settle = (value: void) => value;", []],
      [
        "export const run = (first: string, second: string, third: number) => [first, second, third];\nexport const THIRD: Parameters<typeof run>[2] = 0;",
        [],
      ],
      ["export const double = (count: number) => 2 * count;", ["eslint(no-magic-numbers)"]],
    ] as const;
    const linted = yield* lintErrorsOfEachCase(
      oxlintReport,
      REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      "src",
      cases.map(([code]) => code),
    );
    expect(
      linted.map(({ code, errors }) => ({
        code,
        tags: errors
          .map((error) => {
            const [tag] = error.split(": ");
            return tag;
          })
          .filter((tag) => OPTION_RULE_TAGS.some((optionRuleTag) => optionRuleTag === tag)),
      })),
    ).toEqual(cases.map(([code, tags]) => ({ code, tags: [...tags] })));
  }),
);
