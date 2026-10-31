import { isBuiltin } from "node:module";

const DIRECTIVE =
  /^\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:ignore|expect-error|nocheck)|@effect-diagnostics)/u;

const TYPESCRIPT_SUPPRESSION_ON_A_LAST_LINE = /\n[\s*/]*@ts-(?:ignore|expect-error)[^\n]*$/u;

export const isDirective = (commentText: string) =>
  DIRECTIVE.test(commentText) || TYPESCRIPT_SUPPRESSION_ON_A_LAST_LINE.test(commentText);

export const EFFECT_OPERATION_RULES = {
  "no-dropped-failures": {
    description:
      "Handle Effect, Layer, Stream and Channel failures instead of dying, and read an Option or Result without throwing.",
    operations: {
      Effect: ["orDie", "orDieWith"],
      Layer: ["orDie"],
      Stream: ["orDie"],
      Channel: ["orDie"],
      Option: ["getOrThrow", "getOrThrowWith"],
      Result: ["getOrThrow", "getOrThrowWith"],
    },
  },
  "no-detached-fibers": {
    description: "Fork fibers into a scope instead of detaching them.",
    operations: { Effect: ["forkDetach"] },
  },
  "no-sleep": {
    description: "Wait on signals instead of sleeping.",
    operations: { Effect: ["sleep", "delay"] },
  },
  "no-untraced-functions": {
    description: "Trace Effect functions.",
    operations: { Effect: ["fnUntraced"] },
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly description: string;
      readonly operations: Readonly<Record<string, readonly string[]>>;
    }
  >
>;

export const GLOBAL_RULES = {
  "no-timer-globals": { globals: ["setTimeout", "setInterval", "performance"] },
  "no-global-object": { globals: ["globalThis", "global", "self"] },
} as const satisfies Readonly<Record<string, { readonly globals: readonly string[] }>>;

export const NODE_BUILTIN_RULES = {
  "no-node-path": { modules: ["path", "path/posix", "path/win32"] },
  "no-node-crypto": { modules: ["crypto"] },
  "no-node-os": { modules: ["os"] },
  "no-node-http": { modules: ["http", "https"] },
  "no-node-stream": { modules: ["stream"] },
  "no-node-timers": { modules: ["timers", "timers/promises", "perf_hooks"] },
} as const satisfies Readonly<Record<string, { readonly modules: readonly string[] }>>;

export const SCHEDULE_MESSAGES = {
  polling: "{{usage}} polls on a timer",
  deadline: "{{usage}} polls without a deadline",
  retrying: "{{usage}} retries on a timer",
  retryingEvenWhenGranted:
    "{{usage}} retries on a timer, which no file may do, even with a deadline",
  scheduleEvenWhenGranted:
    "{{usage}} is a timed schedule no file may use; repeat with Schedule.spaced under a deadline in a file allowed pollsWithADeadline",
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
