import { isBuiltin } from "node:module";

const DIRECTIVE = /^[\s\u0085]*(?:(?:oxlint|eslint)-(?:disable|enable)|@effect-diagnostics)/u;

const LINE_COMMENT = "Line";

const TYPESCRIPT_SUPPRESSION_IN_A_LINE_COMMENT = /^\/*[ \t]*@ts-(?:ignore|expect-error)/u;

const TYPESCRIPT_SUPPRESSION_ON_THE_LAST_LINE_OF_A_BLOCK_COMMENT =
  /(?:^|[\n\r\u2028\u2029])[ \t*]*@ts-(?:ignore|expect-error)[^\n\r\u2028\u2029]*$/u;

const TYPESCRIPT_NO_CHECK_IN_A_LINE_COMMENT =
  /^\/?[ \t]*@[Tt][Ss]-[Nn][Oo][Cc][Hh][Ee][Cc][Kk](?![A-Za-z-])/u;

const SHEBANG = /^#![^\n\r\u2028\u2029]*/u;

const ONLY_WHITESPACE = /^[\s\u0085]*$/u;

const isTypeScriptSuppression = (comment: { readonly type: string; readonly value: string }) =>
  comment.type === LINE_COMMENT
    ? TYPESCRIPT_SUPPRESSION_IN_A_LINE_COMMENT.test(comment.value)
    : TYPESCRIPT_SUPPRESSION_ON_THE_LAST_LINE_OF_A_BLOCK_COMMENT.test(comment.value);

const isTypeScriptNoCheck = (comment: { readonly type: string; readonly value: string }) =>
  comment.type === LINE_COMMENT && TYPESCRIPT_NO_CHECK_IN_A_LINE_COMMENT.test(comment.value);

const countOfLeadingComments = (
  text: string,
  comments: readonly { readonly start: number; readonly end: number }[],
) => {
  const codeStart = SHEBANG.exec(text)?.[0].length ?? 0;
  const firstAfterCode = comments.findIndex((comment, index) => {
    const gapStart = index === 0 ? codeStart : (comments[index - 1]?.end ?? codeStart);
    return !ONLY_WHITESPACE.test(text.slice(gapStart, comment.start));
  });
  return firstAfterCode === -1 ? comments.length : firstAfterCode;
};

export const directivesAmong = <
  Comment extends {
    readonly type: string;
    readonly value: string;
    readonly start: number;
    readonly end: number;
  },
>(
  text: string,
  allComments: readonly Comment[],
) => {
  const comments = allComments.filter((comment) => comment.type !== "Shebang");
  const leadingComments = countOfLeadingComments(text, comments);
  return comments.filter(
    (comment, index) =>
      DIRECTIVE.test(comment.value) ||
      isTypeScriptSuppression(comment) ||
      (index < leadingComments && isTypeScriptNoCheck(comment)),
  );
};

export const EFFECT_OPERATION_RULES = {
  "no-dropped-failures": {
    operations: {
      Effect: ["orDie", "orDieWith"],
      Layer: ["orDie"],
      Stream: ["orDie"],
      Channel: ["orDie"],
      Option: ["getOrThrow", "getOrThrowWith"],
      Result: ["getOrThrow", "getOrThrowWith"],
      UndefinedOr: ["getOrThrow", "getOrThrowWith"],
    },
  },
  "no-detached-fibers": {
    operations: { Effect: ["forkDetach"] },
  },
  "no-sleep": {
    operations: {
      Effect: ["sleep", "delay"],
      Stream: ["tick", "debounce", "throttle", "throttleEffect"],
    },
  },
  "no-untraced-functions": {
    operations: { Effect: ["fnUntraced", "fnUntracedEager"] },
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly operations: Readonly<Record<string, readonly string[]>>;
    }
  >
>;

export const GLOBAL_RULES = {
  "no-timer-globals": { globals: ["setTimeout", "setInterval", "performance"] },
  "no-global-object": { globals: ["globalThis", "global", "self"] },
} as const satisfies Readonly<Record<string, { readonly globals: readonly string[] }>>;

export const NODE_BUILTIN_RULES = {
  "no-node-path": { modules: ["path", "path/posix", "path/win32"], allowedImports: [] },
  "no-node-crypto": { modules: ["crypto"], allowedImports: [] },
  "no-node-os": { modules: ["os"], allowedImports: ["constants"] },
  "no-node-http": { modules: ["http", "https"], allowedImports: [] },
  "no-node-stream": { modules: ["stream"], allowedImports: [] },
  "no-node-timers": { modules: ["timers", "timers/promises", "perf_hooks"], allowedImports: [] },
} as const satisfies Readonly<
  Record<
    string,
    { readonly modules: readonly string[]; readonly allowedImports: readonly string[] }
  >
>;

export const SCHEDULE_MESSAGES = {
  polling: "{{usage}} polls on a timer",
  deadline: "{{usage}} polls without a deadline",
  retrying: "{{usage}} retries on a timer",
  scheduleEvenWhenGranted: "{{usage}} is a timed schedule no file may use",
} as const;

export const BUN_TEST = "bun:test";
export const BUN_TEST_ASSERTIONS = new Set(["expect"]);

const NODE_PROTOCOL = "node:";
export const TEST_RUNNER_MODULES = new Set(["vitest", "jest", "@jest/globals", "@effect/vitest"]);
export const ASSERTION_MODULES = new Set([
  "assert",
  "assert/strict",
  "node:assert",
  "node:assert/strict",
  "bun:assert",
  "bun:assert/strict",
]);

const BUN_PROTOCOL = "bun:";
const BUN_MODULES_UNLIKE_THE_NODE_BUILTIN_OF_THE_SAME_NAME: ReadonlySet<string> = new Set([
  "sqlite",
  "test",
]);

export const isNodeBuiltinThatBunAliases = (name: string) =>
  isBuiltin(name) && !BUN_MODULES_UNLIKE_THE_NODE_BUILTIN_OF_THE_SAME_NAME.has(name);

export const nodeBuiltinNameOf = (source: string) => {
  if (source.startsWith(NODE_PROTOCOL)) {
    return source.slice(NODE_PROTOCOL.length);
  }
  const bunName = source.slice(BUN_PROTOCOL.length);
  const isBunAliasOfANodeBuiltin =
    source.startsWith(BUN_PROTOCOL) && isNodeBuiltinThatBunAliases(bunName);
  return isBunAliasOfANodeBuiltin ? bunName : source;
};

export const isTestRunnerModule = (source: string) =>
  TEST_RUNNER_MODULES.has(source) || source.startsWith("vitest/");
