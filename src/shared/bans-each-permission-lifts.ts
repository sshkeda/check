import { Record } from "effect";

import {
  isNodeBuiltinThatBunAliases,
  nodeBuiltinNameOf,
} from "./lint-rule-messages-and-patterns.ts";

export const SYNC_WRITES = [
  "appendFileSync",
  "writeFileSync",
  "writeSync",
  "writevSync",
  "fsyncSync",
  "fdatasyncSync",
  "openSync",
  "closeSync",
] as const;

const SYNC_READS = [
  "accessSync",
  "existsSync",
  "fstatSync",
  "lstatSync",
  "opendirSync",
  "readFileSync",
  "readSync",
  "readdirSync",
  "readlinkSync",
  "readvSync",
  "realpathSync",
  "statSync",
  "statfsSync",
] as const;

const IN_MEMORY_SYNC = [
  "parseSync",
  "decodeSync",
  "decodeUnknownSync",
  "encodeSync",
  "encodeUnknownSync",
  "failSync",
  "failCauseSync",
  "dieSync",
  "endSync",
] as const;

const EFFECT_RUNNERS = ["runSync", "runSyncExit"] as const;

const SYNC_NAME = /.Sync$/u;

const NAMES_OUTSIDE_THE_SYNC_CALL_CHECK: ReadonlySet<string> = new Set([
  ...IN_MEMORY_SYNC,
  ...EFFECT_RUNNERS,
  ...SYNC_WRITES,
  ...SYNC_READS,
]);

export const isDeclaredSync = (name: string) =>
  SYNC_NAME.test(name) && !NAMES_OUTSIDE_THE_SYNC_CALL_CHECK.has(name);

export const TASK_PACKAGE = "@sshkeda/task";
export const TASK_NAMESPACE_EXPORT = "Task";
export const TASK_MAKE_MEMBER = "make";
export const TASK_MAIN_MEMBER = "main";

export const IMPORT_META = "import.meta";

export const MODULE_PATTERN_WILDCARD = "*";

const MODULES_OF_GLOBAL_OBJECTS = {
  Bun: "bun",
  process: "node:process",
} as const;

export const moduleOfGlobalObject = (globalObject: string) =>
  Object.entries(MODULES_OF_GLOBAL_OBJECTS).find(([object]) => object === globalObject)?.[1];

export const moduleBan = (
  modulePatterns: readonly string[],
  exceptImportNames: readonly string[] = [],
) => ({ kind: "module", modulePatterns, exceptImportNames }) as const;

export const importsBan = (modulePattern: string, importNames: readonly string[]) =>
  ({ kind: "imports", modulePattern, importNames }) as const;

const globalMembersBan = (
  globalObject: keyof typeof MODULES_OF_GLOBAL_OBJECTS | typeof IMPORT_META,
  memberNames: readonly string[],
) => ({ kind: "global-members", globalObject, memberNames }) as const;

const effectMembersBan = (
  memberPathPrefixes: readonly (readonly [string, ...string[]])[],
  exceptExactMemberPaths: typeof memberPathPrefixes = [],
) => ({ kind: "effect-members", memberPathPrefixes, exceptExactMemberPaths }) as const;

const memberNamesBan = (memberNames: readonly string[]) =>
  ({ kind: "member-names", memberNames }) as const;

const DYNAMIC_IMPORT_BAN = { kind: "dynamic-import" } as const;

const createdRequireBan = (
  modulePattern: string,
  importNames: readonly string[],
  exceptMemberNames: readonly string[],
) => ({ kind: "created-require", modulePattern, importNames, exceptMemberNames }) as const;

const CREATE_REQUIRE_IMPORTS = ["createRequire", "Module.createRequire"] as const;
export const CREATED_REQUIRE_USAGE = "a require createRequire returns";
export const CREATE_REQUIRE_VALUE_USAGE = "createRequire used other than by a call";

export const SCRIPT = "script";
export const TRUSTS_UNVERIFIED_TYPES = "trustsUnverifiedTypes";
export const WRITES_TO_THE_TERMINAL = "writesToTheTerminal";
export const READS_CONFIG = "readsConfig";
const LOCKS_FILES = "locksFiles";
export const HANDLES_EVERY_FAILURE = "handlesEveryFailure";

const CATCH_ALLS = ["catch", "catchCause", "catchDefect"] as const;
const PREDICATE_CATCHES = ["catchIf", "catchFilter", "catchCauseIf", "catchCauseFilter"] as const;
const IGNORES = ["ignore", "ignoreCause"] as const;
const FIBER_COLLECTION_RUNNERS = [
  "makeRuntime",
  "makeRuntimePromise",
  "run",
  "runtime",
  "runtimePromise",
] as const;

export const OPERATIONS_THAT_HANDLE_UNNAMED_FAILURES = {
  Effect: [
    ...CATCH_ALLS,
    ...PREDICATE_CATCHES,
    ...IGNORES,
    "catchEager",
    "eventually",
    "exit",
    "firstSuccessOf",
    "flip",
    "forkChild",
    "forkIn",
    "forkScoped",
    "isFailure",
    "isSuccess",
    "match",
    "matchCause",
    "matchCauseEager",
    "matchCauseEffect",
    "matchCauseEffectEager",
    "matchEager",
    "matchEffect",
    "option",
    "orElseSucceed",
    "partition",
    "race",
    "raceAll",
    "repeatOrElse",
    "result",
    "retryOrElse",
    "runCallback",
    "runCallbackWith",
    "runFork",
    "runForkWith",
    "runPromise",
    "runPromiseExit",
    "runPromiseExitWith",
    "runPromiseWith",
    "runSync",
    "runSyncExit",
    "runSyncExitWith",
    "runSyncWith",
    "sandbox",
    "validate",
  ],
  Stream: [
    ...CATCH_ALLS,
    ...PREDICATE_CATCHES,
    ...IGNORES,
    "orElseSucceed",
    "race",
    "raceAll",
    "result",
    "callback",
    "runIntoPubSub",
    "runIntoQueue",
    "toAsyncIterable",
    "toAsyncIterableEffect",
    "toAsyncIterableWith",
    "toPubSub",
    "toPubSubTake",
    "toQueue",
    "toReadableStream",
    "toReadableStreamEffect",
    "toReadableStreamWith",
  ],
  Channel: [
    ...CATCH_ALLS,
    ...PREDICATE_CATCHES,
    ...IGNORES,
    "callback",
    "callbackArray",
    "runIntoPubSub",
    "runIntoPubSubArray",
    "runIntoQueue",
    "runIntoQueueArray",
    "toPubSub",
    "toPubSubArray",
    "toPubSubTake",
    "toQueue",
    "toQueueArray",
  ],
  Layer: ["catch", "catchCause"],
  Sink: ["catch", "catchCause", "orElse"],
  Fiber: ["await", "awaitAll"],
  Pull: ["matchEffect"],
  Deferred: ["complete", "into"],
  Queue: ["into", "poll", "takeUnsafe"],
  FiberSet: FIBER_COLLECTION_RUNNERS,
  FiberMap: FIBER_COLLECTION_RUNNERS,
  FiberHandle: FIBER_COLLECTION_RUNNERS,
  Pool: ["make", "makeWithStrategy", "makeWithTTL"],
  Runtime: ["makeRunMain"],
} as const;

const PLATFORM_RUNNER = "runMain";

const OUTCOME_MEMBERS = [
  "addObserver",
  "pollUnsafe",
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
] as const;

const GRANTABLE_BANS = {
  [READS_CONFIG]: {
    ruleName: "no-config-reads",
    message: `{{usage}} reads configuration`,
    bans: [
      globalMembersBan("process", ["env", "argv"]),
      effectMembersBan(
        [["Config"]],
        [
          ["Config", "ConfigError"],
          ["Config", "isConfigError"],
        ],
      ),
    ],
    bannedEvenWhenGranted: {
      message:
        "{{usage}} reads configuration, which no file may do; read it through Effect Config, process.env or process.argv in a file allowed readsConfig",
      bans: [
        globalMembersBan("process", ["argv0"]),
        globalMembersBan("Bun", ["env", "argv"]),
        globalMembersBan(IMPORT_META, ["env"]),
        importsBan("node:util", ["parseArgs"]),
      ],
    },
  },
  spawnsCommands: {
    ruleName: "no-command-spawn",
    message: "{{usage}} starts a command directly",
    bans: [
      moduleBan(["effect/process/ChildProcess", "effect/process/ChildProcessSpawner"]),
      importsBan("effect/process", ["ChildProcess", "ChildProcessSpawner"]),
      globalMembersBan("Bun", ["spawn"]),
      importsBan("node:child_process", ["spawn"]),
    ],
    bannedEvenWhenGranted: {
      message:
        "{{usage}} starts a command in a way no file may; start it through Effect ChildProcess in a file allowed spawnsCommands",
      bans: [
        moduleBan(["node:child_process"], ["spawn"]),
        moduleBan(["@effect/platform-*/*ChildProcessSpawner"]),
        importsBan("@effect/platform-*", ["BunChildProcessSpawner", "NodeChildProcessSpawner"]),
        globalMembersBan("Bun", ["spawnSync", "$"]),
      ],
    },
  },
  [LOCKS_FILES]: {
    ruleName: "no-node-file-system",
    message: "{{usage}} reaches the file system directly",
    bans: [importsBan("node:fs", ["constants"]), importsBan("node:fs/promises", ["open"])],
    bannedEvenWhenGranted: {
      message:
        "{{usage}} reaches the file system in a way no file may; use the Effect FileSystem service, or take a file lock with open from node:fs/promises and constants from node:fs in a file allowed locksFiles",
      bans: [
        moduleBan(["node:fs"], ["constants", ...SYNC_WRITES, ...SYNC_READS]),
        moduleBan(["node:fs/promises"], ["open"]),
      ],
    },
  },
  importsDynamically: {
    ruleName: "no-dynamic-import",
    message: "{{usage}} is banned",
    bans: [DYNAMIC_IMPORT_BAN, importsBan("node:module", CREATE_REQUIRE_IMPORTS)],
    bannedEvenWhenGranted: {
      message:
        "{{usage}} loads code in a way no file may; use import() in a file allowed importsDynamically",
      bans: [
        globalMembersBan(IMPORT_META, ["require"]),
        moduleBan(["node:vm"]),
        createdRequireBan("node:module", CREATE_REQUIRE_IMPORTS, ["resolve"]),
      ],
    },
  },
  exitsTheProcess: {
    ruleName: "no-process-exit",
    message: "{{usage}} exits the process directly",
    bans: [globalMembersBan("process", ["exit"])],
  },
  usesSqlDatabases: {
    ruleName: "no-sql-clients",
    message: "{{usage}} uses a SQL client outside a usesSqlDatabases file",
    bans: [
      moduleBan(["@effect/sql", "@effect/sql-*", "effect/sql", "effect/sql/*"]),
      importsBan(MODULE_PATTERN_WILDCARD, ["SqlClient"]),
    ],
    bannedEvenWhenGranted: {
      message:
        "{{usage}} is a SQL client no file may use; use Effect SQL in a file allowed usesSqlDatabases",
      bans: [
        moduleBan([
          "bun:sqlite",
          "node:sqlite",
          "sqlite3",
          "better-sqlite3",
          "pg",
          "pg/*",
          "postgres",
          "mysql2",
          "mysql2/*",
        ]),
        globalMembersBan("Bun", ["SQL", "sql"]),
      ],
    },
  },
  [WRITES_TO_THE_TERMINAL]: {
    ruleName: "no-terminal-writes",
    message: "{{usage}} writes to the terminal",
    bans: [],
    bannedEvenWhenGranted: {
      message:
        "{{usage}} writes to the terminal in a way no file may; write through the Effect Stdio service in a file allowed writesToTheTerminal",
      bans: [
        effectMembersBan([["Console"]]),
        moduleBan(["node:console"]),
        globalMembersBan("process", ["stdout", "stderr"]),
        globalMembersBan("Bun", ["stdout", "stderr"]),
      ],
    },
  },
};

export const PERMISSION_BANS = {
  ...GRANTABLE_BANS,
  [TRUSTS_UNVERIFIED_TYPES]: {
    ruleName: "no-unverified-types",
    message: `{{usage}} declares a type nothing verifies`,
    bans: [
      effectMembersBan([
        ["Schema", "declare"],
        ["Schema", "declareConstructor"],
      ]),
    ],
  },
  [HANDLES_EVERY_FAILURE]: {
    ruleName: "no-unnamed-recovery",
    message: "{{usage}} handles failures it does not name",
    bans: [
      effectMembersBan(
        Object.entries(OPERATIONS_THAT_HANDLE_UNNAMED_FAILURES).flatMap(
          ([moduleName, operations]) =>
            operations.map((operation) => [moduleName, operation] as const),
        ),
      ),
      memberNamesBan([...OUTCOME_MEMBERS, PLATFORM_RUNNER]),
      importsBan(MODULE_PATTERN_WILDCARD, [PLATFORM_RUNNER]),
    ],
  },
  syncFileAccess: {
    ruleName: "no-sync-file-access",
    message: "{{usage}} reaches the file system synchronously",
    bans: [
      importsBan(MODULE_PATTERN_WILDCARD, [...SYNC_READS, ...SYNC_WRITES]),
      memberNamesBan([...SYNC_READS, ...SYNC_WRITES]),
    ],
  },
  [SCRIPT]: {
    ruleName: "no-task-main",
    message: "{{usage}} runs tasks outside a script",
    bans: [importsBan(TASK_PACKAGE, [`${TASK_NAMESPACE_EXPORT}.${TASK_MAIN_MEMBER}`])],
  },
};

export const PERMISSION_BAN_NAMES = Record.keys(PERMISSION_BANS);

export const BANS_NO_GRANT_LIFTS = "onlyThoseNoGrantLifts";

export const UNUSED_GRANT_REPORTED = "reported";

export const unusedGrantMessage = (permission: string) =>
  `this file is granted ${permission}, but uses nothing ${permission} allows`;

export const bansNoGrantLifts = (permission: keyof typeof PERMISSION_BANS) => {
  const entry = PERMISSION_BANS[permission];
  return "bannedEvenWhenGranted" in entry ? entry.bannedEvenWhenGranted.bans : [];
};

export const everyBanOf = (entry: (typeof PERMISSION_BANS)[keyof typeof PERMISSION_BANS]) => [
  ...entry.bans,
  ...("bannedEvenWhenGranted" in entry ? entry.bannedEvenWhenGranted.bans : []),
];

export const SHORT_NAMES = "usesAbbreviations";

export const RULES_EACH_PERMISSION_LIFTS = {
  [SHORT_NAMES]: "no-abbreviations",
} as const;

export const GRANTABLE_BAN_NAMES = Record.keys(GRANTABLE_BANS);

export const equivalentModuleSpecifiers = (specifier: string) => {
  const builtinName = nodeBuiltinNameOf(specifier);
  if (builtinName === specifier) {
    return [specifier];
  }
  return [
    `node:${builtinName}`,
    builtinName,
    ...(isNodeBuiltinThatBunAliases(builtinName) ? [`bun:${builtinName}`] : []),
  ];
};

export const moduleSpecifiersOfGlobalObject = (globalObject: string) => {
  const module = moduleOfGlobalObject(globalObject);
  return module === undefined ? [] : equivalentModuleSpecifiers(module);
};
