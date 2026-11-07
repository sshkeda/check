import { eslintCompatPlugin } from "@oxlint/plugins";
import { Record } from "effect";

import {
  everyBanOf,
  IMPORT_META,
  moduleSpecifiersOfGlobalObject,
  PERMISSION_BAN_NAMES,
  PERMISSION_BANS,
} from "../shared/bans-each-permission-lifts.ts";
import {
  EFFECT_OPERATION_RULES,
  GLOBAL_RULES,
  NODE_BUILTIN_RULES,
} from "../shared/lint-rule-messages-and-patterns.ts";
import {
  grantPermissions,
  permissionBanRuleId,
  FAILURES_AS_RESULTS_RULE,
  STDIO_SERVICE_RULE,
  TEST_TIMEOUTS_RULE,
  TYPE_PREDICATES_RULE,
} from "../shared/record-and-grant-permissions-by-path.ts";
import { noAbbreviations } from "./ban-abbreviated-words-in-declared-names.ts";
import { noUncalledMembers } from "./ban-checked-members-outside-calls.ts";
import { noComments } from "./ban-comments.ts";
import { noManualTag, noTagBranching } from "./ban-comparing-or-switching-on-tag.ts";
import { noTestTimeouts } from "./ban-deadlines-inside-tests.ts";
import { noDeclaredValues } from "./ban-declared-values.ts";
import { effectOperationRule } from "./ban-dropped-failures-detached-fibers-sleeps-and-untraced-functions.ts";
import { noFailuresAsResults } from "./ban-failures-collected-as-results.ts";
import { noUnnamedFallbacks } from "./ban-fallbacks-of-named-recoveries.ts";
import { noOverloads } from "./ban-function-overloads.ts";
import { noPlainErrorFailures } from "./ban-global-error-in-failure-types.ts";
import { noErrorInstanceof } from "./ban-instanceof-in-effect-recovery-callbacks.ts";
import { noLet, noMutableRef } from "./ban-let-and-effect-mutable-ref.ts";
import { noIndexLogic } from "./ban-logic-in-index-files.ts";
import { noNamespaceAliases } from "./ban-namespaces-used-without-a-member.ts";
import { nodeBuiltinRule } from "./ban-node-builtins-that-effect-replaces.ts";
import { noUncheckedParsing } from "./ban-parsing-outside-data-without-a-schema.ts";
import { noReExports } from "./ban-re-exports.ts";
import {
  CLOCK_PROPERTIES,
  noClockReadsAndSleeps,
} from "./ban-reading-the-clock-and-sleeping-outside-effect.ts";
import { noExistsRecovery } from "./ban-recovering-file-system-exists.ts";
import { noRetiredWords } from "./ban-retired-words-in-names.ts";
import { noInstantRetries } from "./ban-retries-without-a-wait.ts";
import { noGlobScan } from "./ban-scanning-directories-with-bun-glob.ts";
import { noShebang } from "./ban-shebang-lines.ts";
import { globalRule } from "./ban-timer-globals-and-the-global-object.ts";
import { noSchedules } from "./ban-timer-schedules-without-deadlines.ts";
import { noTypeDeclarations } from "./ban-type-and-interface-declarations.ts";
import { noTypePredicates } from "./ban-type-predicates.ts";
import { noUnknownBoundaries } from "./ban-unknown-in-function-signatures.ts";
import { noVagueErrorNames } from "./ban-vague-error-class-names.ts";
import { noVagueFileNames } from "./ban-vague-file-names.ts";
import { permissionBanRule } from "./ban-what-a-file-is-not-granted.ts";
import { noWhile } from "./ban-while-do-while-and-for-loops.ts";
import { noSharedHolders } from "./ban-writing-captured-objects-inside-effect-callbacks.ts";
import {
  noServiceDeclarations,
  noUnusedServiceGrants,
} from "./confine-service-declarations-to-granted-files.ts";
import { noStdioService } from "./confine-the-stdio-service-to-terminal-output.ts";
import {
  noAssertions,
  noTestRunners,
} from "./keep-assertions-in-the-test-home-and-ban-test-runners.ts";
import { noTestingHelpers } from "./keep-effect-testing-helpers-in-test-files.ts";
import { bansByKind } from "./match-banned-modules-and-globals.ts";
import { noUnnamedCompoundConditions } from "./require-a-named-const-for-compound-conditions.ts";
import { noLooseLiteralConstants } from "./require-capital-snake-case-and-as-const-on-literal-constants.ts";
import { noMismatchedServiceKeys } from "./require-service-keys-to-end-with-their-class-name.ts";
import { noUnsortedTypeConstituents } from "./sort-type-constituents.ts";

const NAME_BASED_RESTRICTED_PROPERTIES = [
  { object: "Reflect", property: "get" },
  { object: "Reflect", property: "apply" },
  { object: "JSON", property: "parse" },
  { object: "JSON", property: "stringify" },
  { object: "Date", property: "now" },
  { object: "Bun", property: "sleep" },
  { object: "Bun", property: "file" },
  { object: "Bun", property: "write" },
  { object: "Bun", property: "serve" },
  { object: "process", property: "exitCode" },
  { object: "process", property: "getBuiltinModule" },
  { object: "mock", property: "module" },
] as const;

export const RESTRICTED_PROPERTIES = [
  ...NAME_BASED_RESTRICTED_PROPERTIES,
  ...CLOCK_PROPERTIES,
] as const;

export const RESTRICTED_IMPORT_PATHS = RESTRICTED_PROPERTIES.flatMap(({ object, property }) =>
  moduleSpecifiersOfGlobalObject(object).map((name) => ({
    name,
    importNames: [property],
    allowTypeImports: true,
  })),
);

const CONSOLE = "console";

const GLOBALS_WHOSE_MEMBERS_OTHER_RULES_BAN = ["Atomics", "Intl", "Number"] as const;

const GLOBALS_WHOSE_MEMBERS_PERMISSIONS_BAN = Object.values(PERMISSION_BANS)
  .flatMap((entry) => bansByKind(everyBanOf(entry)).globalMembers)
  .map(({ globalObject }) => globalObject)
  .filter((globalObject) => globalObject !== IMPORT_META);

const TABLE_RULES = {
  ...Record.map(EFFECT_OPERATION_RULES, (_rule, name) => effectOperationRule(name)),
  ...Record.map(NODE_BUILTIN_RULES, (_rule, name) => nodeBuiltinRule(name)),
  ...Record.map(GLOBAL_RULES, (_rule, name) => globalRule(name)),
};

const NAMED_RULES = {
  "no-unsorted-type-constituents": noUnsortedTypeConstituents,
  "no-error-instanceof": noErrorInstanceof,
  "no-abbreviations": noAbbreviations,
  "no-retired-words": noRetiredWords,
  "no-vague-file-names": noVagueFileNames,
  "no-index-logic": noIndexLogic,
  "no-vague-error-names": noVagueErrorNames,
  "no-plain-error-failures": noPlainErrorFailures,
  "no-comments": noComments,
  "no-manual-tag": noManualTag,
  "no-tag-branching": noTagBranching,
  "no-mismatched-service-keys": noMismatchedServiceKeys,
  "no-clock-reads-and-sleeps": noClockReadsAndSleeps,
  "no-unchecked-parsing": noUncheckedParsing,
  "no-schedules": noSchedules,
  "no-instant-retries": noInstantRetries,
  "no-service-declarations": noServiceDeclarations,
  "no-unused-service-grants": noUnusedServiceGrants,
  "no-glob-scan": noGlobScan,
  "no-unknown-boundaries": noUnknownBoundaries,
  "no-loose-literal-constants": noLooseLiteralConstants,
  "no-type-declarations": noTypeDeclarations,
  "no-declared-values": noDeclaredValues,
  [TYPE_PREDICATES_RULE]: noTypePredicates,
  [STDIO_SERVICE_RULE]: noStdioService,
  [FAILURES_AS_RESULTS_RULE]: noFailuresAsResults,
  "no-overloads": noOverloads,
  "no-re-exports": noReExports,
  "no-testing-helpers": noTestingHelpers,
  "no-assertions": noAssertions,
  "no-test-runners": noTestRunners,
  "no-unnamed-compound-conditions": noUnnamedCompoundConditions,
  "no-let": noLet,
  "no-mutable-ref": noMutableRef,
  "no-while": noWhile,
  "no-shebang": noShebang,
  "no-shared-holders": noSharedHolders,
  "no-uncalled-members": noUncalledMembers,
  "no-unnamed-fallbacks": noUnnamedFallbacks,
  "no-exists-recovery": noExistsRecovery,
  "no-namespace-aliases": noNamespaceAliases(
    new Set([
      ...RESTRICTED_PROPERTIES.map(({ object }) => object),
      ...GLOBALS_WHOSE_MEMBERS_PERMISSIONS_BAN,
      ...GLOBALS_WHOSE_MEMBERS_OTHER_RULES_BAN,
      CONSOLE,
    ]),
  ),
};

const TEST_HOME_RULES = {
  [TEST_TIMEOUTS_RULE]: noTestTimeouts,
};

const OWN_RULE_SEVERITIES = Object.fromEntries(
  Object.keys({ ...NAMED_RULES, ...TABLE_RULES }).map(
    (name) => [`sshkeda/${name}`, "error"] as const,
  ),
);

const PERMISSION_BAN_RULES = Object.fromEntries(
  PERMISSION_BAN_NAMES.map((permission) => [
    PERMISSION_BANS[permission].ruleName,
    permissionBanRule(permission),
  ]),
);

const PERMISSION_BAN_RULE_SEVERITIES = Object.fromEntries(
  PERMISSION_BAN_NAMES.map((permission) => [permissionBanRuleId(permission), "error"] as const),
);

export const RESTRICTED_TYPES = {
  object: true,
  "{}": true,
  "Record<string, unknown>": true,
  "Record<string, object>": true,
  "Record<PropertyKey, unknown>": true,
} as const;

export default eslintCompatPlugin({
  meta: { name: "sshkeda" },
  rules: {
    ...NAMED_RULES,
    ...TABLE_RULES,
    ...PERMISSION_BAN_RULES,
    ...TEST_HOME_RULES,
  },
});

const baseConfig = {
  ignorePatterns: ["**/node_modules/**"],
  options: { typeAware: true, denyWarnings: true },
  plugins: ["eslint", "typescript", "unicorn", "oxc", "node", "import"],
  jsPlugins: [{ name: "sshkeda", specifier: import.meta.filename }],
  categories: { correctness: "error", perf: "error" },
  rules: Object.fromEntries([
    ...Object.entries(OWN_RULE_SEVERITIES),
    ...Object.entries(PERMISSION_BAN_RULE_SEVERITIES),
    ...Object.entries({
      "eslint/array-callback-return": "error",
      "eslint/arrow-body-style": "error",
      "eslint/class-methods-use-this": ["error", { ignoreOverrideMethods: true }],
      "eslint/curly": ["error", "all"],
      "eslint/eqeqeq": "error",
      "eslint/func-style": "error",
      "eslint/id-length": "error",
      "eslint/no-console": "error",
      "eslint/no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "eslint/no-else-return": "error",
      "eslint/no-empty": "error",
      "eslint/no-empty-function": ["error", { allow: ["privateConstructors"] }],
      "eslint/no-implicit-coercion": "error",
      "eslint/no-lone-blocks": "error",
      "eslint/no-lonely-if": "error",
      "eslint/no-magic-numbers": ["error", { ignore: [0, 1, -1], ignoreTypeIndexes: true }],
      "eslint/no-nested-ternary": "error",
      "eslint/no-param-reassign": "error",
      "eslint/no-regex-spaces": "error",
      "eslint/no-shadow": "error",
      "eslint/no-template-curly-in-string": "error",
      "eslint/no-unneeded-ternary": "error",
      "eslint/no-unused-private-class-members": "error",
      "eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "eslint/no-use-before-define": "error",
      "eslint/no-useless-computed-key": "error",
      "eslint/no-useless-concat": "error",
      "eslint/no-useless-constructor": "error",
      "eslint/no-useless-return": "error",
      "eslint/no-var": "error",
      "eslint/no-void": ["error", { allowAsStatement: true }],
      "eslint/object-shorthand": "error",
      "eslint/prefer-const": "error",
      "eslint/no-restricted-properties": ["error", ...NAME_BASED_RESTRICTED_PROPERTIES],
      "eslint/no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }],
      "eslint/prefer-named-capture-group": "error",
      "eslint/prefer-object-spread": "error",
      "eslint/prefer-regex-literals": "error",
      "eslint/prefer-template": "error",
      "eslint/require-unicode-regexp": "error",
      "typescript/array-type": "error",
      "typescript/consistent-indexed-object-style": ["error", "record"],
      "typescript/consistent-type-imports": "error",
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "typescript/dot-notation": "error",
      "typescript/explicit-member-accessibility": "error",
      "typescript/no-confusing-void-expression": "error",
      "typescript/no-deprecated": "error",
      "typescript/no-dynamic-delete": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-extraneous-class": "error",
      "typescript/no-import-type-side-effects": "error",
      "typescript/no-inferrable-types": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-require-imports": "error",
      "typescript/no-restricted-types": ["error", { types: RESTRICTED_TYPES }],
      "typescript/no-unnecessary-boolean-literal-compare": "error",
      "typescript/no-unnecessary-condition": "error",
      "typescript/no-unnecessary-template-expression": "error",
      "typescript/no-unnecessary-type-arguments": "error",
      "typescript/no-unnecessary-type-constraint": "error",
      "typescript/no-unnecessary-type-conversion": "error",
      "typescript/no-unnecessary-type-parameters": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/only-throw-error": "error",
      "typescript/parameter-properties": "error",
      "typescript/prefer-find": "error",
      "typescript/prefer-for-of": "error",
      "typescript/prefer-includes": "error",
      "typescript/prefer-nullish-coalescing": "error",
      "typescript/prefer-optional-chain": "error",
      "typescript/prefer-promise-reject-errors": "error",
      "typescript/prefer-regexp-exec": "error",
      "typescript/prefer-string-starts-ends-with": "error",
      "typescript/strict-boolean-expressions": "error",
      "typescript/strict-void-return": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/use-unknown-in-catch-callback-variable": "error",
      "unicorn/catch-error-name": "error",
      "unicorn/consistent-existence-index-check": "error",
      "unicorn/consistent-function-scoping": "error",
      "unicorn/escape-case": "error",
      "unicorn/explicit-length-check": "error",
      "unicorn/filename-case": "error",
      "unicorn/new-for-builtins": "error",
      "unicorn/no-array-callback-reference": "error",
      "unicorn/no-array-for-each": "error",
      "unicorn/no-array-reduce": "error",
      "unicorn/no-array-sort": "error",
      "unicorn/no-hex-escape": "error",
      "unicorn/no-immediate-mutation": "error",
      "unicorn/no-instanceof-builtins": "error",
      "unicorn/no-negated-condition": "error",
      "unicorn/no-static-only-class": "error",
      "unicorn/no-typeof-undefined": "error",
      "unicorn/no-useless-undefined": "error",
      "unicorn/numeric-separators-style": "error",
      "unicorn/prefer-add-event-listener": "error",
      "unicorn/prefer-array-index-of": "error",
      "unicorn/prefer-array-some": "error",
      "unicorn/prefer-at": "error",
      "unicorn/prefer-code-point": "error",
      "unicorn/prefer-logical-operator-over-ternary": "error",
      "unicorn/prefer-negative-index": "error",
      "unicorn/prefer-node-protocol": "error",
      "unicorn/prefer-number-properties": "error",
      "unicorn/prefer-single-call": "error",
      "unicorn/prefer-spread": "error",
      "unicorn/prefer-string-raw": "error",
      "unicorn/prefer-string-replace-all": "error",
      "unicorn/prefer-structured-clone": "error",
      "unicorn/prefer-ternary": "error",
      "unicorn/relative-url-style": "error",
      "unicorn/switch-case-braces": "error",
      "oxc/branches-sharing-code": "error",
      "oxc/no-const-enum": "error",
      "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-anonymous-default-export": "error",
      "import/no-cycle": "error",
      "import/no-duplicates": "error",
      "import/no-mutable-exports": "error",
      "import/no-self-import": "error",
      "import/no-unassigned-import": "error",
    } as const),
  ]),
} as const;

export const lintConfig = (permissionsByPath: Parameters<typeof grantPermissions>[1]) =>
  grantPermissions(baseConfig, permissionsByPath);

export const FORMAT_CONFIG = {
  sortImports: true,
  useTabs: false,
  tabWidth: 2,
  printWidth: 100,
  endOfLine: "lf",
  insertFinalNewline: true,
  singleQuote: false,
} as const;
