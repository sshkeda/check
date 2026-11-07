import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { PLUGIN } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { oxlintBinary } from "../shared/oxlint-binary.ts";

const PERMITTED = `import { Config, Context, Effect, Schedule, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { SqlClient } from "effect/sql/SqlClient";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

export class Store extends Context.Service<Store, {}>()("Store") {}
export const database = Effect.map(SqlClient, (client) => client);
export const load = (specifier: string) => import(specifier);
export const opened = () => open("trace.log", constants.O_RDONLY);
export const poll = (work: Effect.Effect<void>) =>
  work.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.timeout("30 seconds"));
export const port = Config.int("PORT");
export const home = process.env.HOME;
export const commandLine = () => process.argv;
export const start = () => [spawn, Bun.spawn(["git"])];
export const stop = () => process.exit(1);
export const listing = ChildProcess.make("ls");
export const resolved = createRequire(import.meta.url).resolve("effect");
export const Port = Schema.declare((input): input is number => typeof input === "number");
export const outcome = (work: Effect.Effect<void, string>) => Effect.exit(work);
export const settled = (works: readonly Effect.Effect<void, string>[]) => Effect.all(works, { mode: "result" });
`;

const STILL_BANNED = `${PERMITTED}import { join } from "node:path";
import { appendFileSync } from "node:fs";
export const append = (line: string) => appendFileSync("trace.log", line);
export const isPort = (value: number): value is 1 => value === 1;
export const joined = () => join("trace", "log");
export const decoded = JSON.parse("1");
export const unbounded = (work: Effect.Effect<void>) => work.pipe(Effect.retry(Schedule.spaced("1 second")));
`;

const ALL_PERMISSIONS =
  '{ allow: ["pollsWithADeadline", "readsConfig", "importsDynamically", "exitsTheProcess", "spawnsCommands", "usesSqlDatabases", "locksFiles", "writesToTheTerminal", "trustsUnverifiedTypes", "handlesEveryFailure"], services: ["Store"] }';

const COMMENT_RULE = "sshkeda/no-comments";
const ABBREVIATION_RULE = "sshkeda/no-abbreviations";

const lintWithPermissions = Effect.fn("lintWithPermissions")(function* (
  permissionsByFile: string,
  files: Readonly<Record<string, string>>,
  skippedRules: readonly string[] = [COMMENT_RULE, ABBREVIATION_RULE],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  const plugin = yield* encodeJson(PLUGIN);
  yield* fileSystem.symlink(
    yield* path.fromFileUrl(new URL("../../node_modules", import.meta.url)),
    path.join(directory, "node_modules"),
  );
  yield* fileSystem.writeFileString(
    path.join(directory, "oxlint.config.ts"),
    `import { lintConfig } from ${plugin};
const config = lintConfig({});
const skippedRules = new Set(${yield* encodeJson(skippedRules)});
const ruleNames = Object.keys(config.rules).filter((rule) => !rule.startsWith("typescript/") && !skippedRules.has(rule));
export default {
  plugins: config.plugins,
  jsPlugins: config.jsPlugins,
  rules: Object.fromEntries(ruleNames.map((rule) => [rule, config.rules[rule]])),
  overrides: lintConfig(${permissionsByFile}).overrides,
};`,
  );
  for (const [name, text] of Object.entries(files)) {
    yield* fileSystem.makeDirectory(path.dirname(path.join(directory, name)), { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, name), text);
  }
  return yield* Task.exec(
    "bun",
    [
      yield* oxlintBinary,
      "--config",
      path.join(directory, "oxlint.config.ts"),
      "--format",
      "agent",
      "--",
      ...Object.keys(files),
    ],
    { cwd: directory },
  ).pipe(
    Effect.as(""),
    Effect.catchTag("CommandFailed", (failure) =>
      Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
    ),
  );
});

const expectOnlyUnpermittedViolations = (output: string) => {
  expect(output).toContain("importing node:path is banned");
  expect(output).toContain("JSON.parse");
  expect(output).toContain("Schedule.spaced polls without a deadline");
  expect(output).not.toContain("declares a service");
  expect(output).not.toContain("dynamic import()");
  expect(output).toContain("appendFileSync from node:fs reaches the file system synchronously");
  expect(output).toContain("`value is 1` is an unchecked type predicate");
  expect(output).not.toContain("`input is number`");
  expect(output).not.toContain("declares a type nothing verifies");
  expect(output).not.toContain("reads configuration");
  expect(output).not.toContain("starts a command");
  expect(output).not.toContain("createRequire from node:module is banned");
  expect(output).not.toContain("node:vm is banned");
  expect(output).not.toContain("no-process-exit");
  expect(output).not.toContain("uses a SQL client");
  expect(output).not.toContain("declares an error class");
  expect(output).not.toContain("reaches the file system directly");
  expect(output).not.toContain("in a way no file may");
  expect(output).not.toContain("runs tasks outside a script");
  expect(output).not.toContain("writes to the terminal");
  expect(output).not.toContain("handles failures it does not name");
  expect(output).not.toContain("turns each failure into a result");
};

export const permissionsComposeInOneEntry = Task.make(
  "every permission granted to a file re-allows only its own restriction",
  Effect.gen(function* () {
    const permissionsByFile = `{ "permitted.ts": ${ALL_PERMISSIONS} }`;
    expect(yield* lintWithPermissions(permissionsByFile, { "permitted.ts": PERMITTED })).toBe("");
    expectOnlyUnpermittedViolations(
      yield* lintWithPermissions(permissionsByFile, { "permitted.ts": STILL_BANNED }),
    );
  }).pipe(Effect.scoped),
);

export const directoryGrantsLeaveDescendantCodeBansEnabled = Task.make(
  "a directory grant leaves code bans enabled in its descendants, and a file grant lifts only that file's ban",
  Effect.gen(function* () {
    const files = {
      ".github/actions/run.ts": "export const STOP = () => process.exit(1);\n",
      ".github/actions/other.ts": "export const STOP = () => process.exit(1);\n",
    };
    const directoryOnly = yield* lintWithPermissions(
      '{ ".github": { allow: ["isAnUnlistedDirectory"] } }',
      files,
    );
    expect(directoryOnly).toContain("run.ts");
    expect(directoryOnly).toContain("other.ts");
    expect(directoryOnly).toContain("exits the process directly");
    const oneFile = yield* lintWithPermissions(
      '{ ".github": { allow: ["isAnUnlistedDirectory"] }, ".github/actions/run.ts": { allow: ["exitsTheProcess"] } }',
      files,
    );
    expect(oneFile).not.toContain("run.ts");
    expect(oneFile).toContain("other.ts");
    expect(oneFile).toContain("exits the process directly");
  }).pipe(Effect.scoped),
);

export const grantsThatLiftNothingAreReported = Task.make(
  "a file granted a permission whose ban it no longer reaches is reported at its first line, while a grant the file uses and a readsConfig grant are not",
  Effect.gen(function* () {
    const output = yield* lintWithPermissions(
      '{ "stop.ts": { allow: ["exitsTheProcess", "spawnsCommands", "usesSqlDatabases", "readsConfig"] } }',
      { "stop.ts": "export const STOP = () => process.exit(1);\n" },
    );
    expect(output).toContain(
      "stop.ts:1:1: error sshkeda(no-command-spawn): this file is granted spawnsCommands, but uses nothing spawnsCommands allows",
    );
    expect(output).toContain(
      "stop.ts:1:1: error sshkeda(no-sql-clients): this file is granted usesSqlDatabases, but uses nothing usesSqlDatabases allows",
    );
    expect(output).not.toContain("granted exitsTheProcess");
    expect(output).not.toContain("granted readsConfig");
    expect(output).not.toContain("exits the process directly");
  }).pipe(Effect.scoped),
);

const RUNTIME_NAMES = `export const env = new Map([["HOME", "/"]]);
export const cwd = (directory: string) => directory;
export const stdin = (input: ReadableStream) => input;
`;

export const onlyAFileGrantedShortNamesMayDeclareAbbreviatedNames = Task.make(
  "a file granted usesAbbreviations may declare env, cwd and stdin, while the same names still fail in its neighbour and in a file without a grant",
  Effect.gen(function* () {
    const files = { "src/runtime.ts": RUNTIME_NAMES, "src/neighbour.ts": RUNTIME_NAMES };
    const ungranted = yield* lintWithPermissions("{}", files, [COMMENT_RULE]);
    expect(ungranted).toContain("runtime.ts");
    expect(ungranted).toContain("`env` contains an abbreviation of environment");
    expect(ungranted).toContain("`cwd` contains an abbreviation of working directory");
    expect(ungranted).toContain("`stdin` contains an abbreviation of standard input");
    const granted = yield* lintWithPermissions(
      '{ "src/runtime.ts": { allow: ["usesAbbreviations"] } }',
      files,
      [COMMENT_RULE],
    );
    expect(granted).not.toContain("runtime.ts");
    expect(granted).toContain("neighbour.ts");
    expect(granted).toContain("`env` contains an abbreviation of environment");
    expect(granted).toContain("`cwd` contains an abbreviation of working directory");
    expect(granted).toContain("`stdin` contains an abbreviation of standard input");
    expect(
      yield* lintWithPermissions(
        '{ "src/runtime.ts": { allow: ["usesAbbreviations"] } }',
        {
          "src/runtime.ts": RUNTIME_NAMES,
        },
        [COMMENT_RULE],
      ),
    ).toBe("");
  }).pipe(Effect.scoped),
);

const READS_RAW_ARGUMENTS = `import { parseArgs } from "node:util";

const FIRST_ARGUMENT_AFTER_THE_SCRIPT = 2;
export const commandLine = () => [
  process.argv.slice(FIRST_ARGUMENT_AFTER_THE_SCRIPT),
  Bun.argv,
  parseArgs({}),
];
`;

export const theConfigGrantLiftsTheRawArgumentsBan = Task.make(
  "a file without a grant may not read raw command-line arguments, a file granted readsConfig may read process.argv, and no file may read Bun.argv or parseArgs",
  Effect.gen(function* () {
    const ungranted = yield* lintWithPermissions("{}", { "reads.ts": READS_RAW_ARGUMENTS });
    expect(ungranted).toContain("process.argv reads configuration");
    expect(ungranted).toContain("Bun.argv reads configuration, which no file may do");
    expect(ungranted).toContain(
      "parseArgs from node:util reads configuration, which no file may do",
    );
    const granted = yield* lintWithPermissions('{ "reads.ts": { allow: ["readsConfig"] } }', {
      "reads.ts": READS_RAW_ARGUMENTS,
    });
    expect(granted).not.toContain("process.argv reads configuration");
    expect(granted).toContain("Bun.argv reads configuration, which no file may do");
    expect(granted).toContain("parseArgs from node:util reads configuration, which no file may do");
  }).pipe(Effect.scoped),
);

const POLLS_WITH_A_DEADLINE = `import { Effect, Schedule } from "effect";

export const poll = (work: Effect.Effect<void>) =>
  work.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.timeout("30 seconds"));
`;

const RETRIES_WITH_A_DEADLINE = `import { Effect, Schedule } from "effect";

export const retried = (work: Effect.Effect<void>) =>
  Effect.retry(work, Schedule.spaced("1 second")).pipe(Effect.timeout("30 seconds"));
`;

const RETRIES_WITHOUT_A_DEADLINE = `import { Effect, Schedule } from "effect";

export const retried = (work: Effect.Effect<void>) => Effect.retry(work, Schedule.spaced("1 second"));
`;

const RETRIES_AT_ONCE = `import { Effect, Schedule } from "effect";

export const retried = (work: Effect.Effect<void>) =>
  Effect.retry(work, Schedule.recurs(3)).pipe(Effect.timeout("30 seconds"));
`;

const MOVES_VIRTUAL_TIME = `import { Effect, Schedule } from "effect";
import { TestClock } from "effect/testing";

const ATTEMPTS = 3;
export const advanced = (work: Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    yield* Effect.retry(work, Schedule.recurs(ATTEMPTS));
  });
`;

const POLLS_WITHOUT_A_DEADLINE = `import { Effect, Schedule } from "effect";

export const poll = (work: Effect.Effect<void>) => work.pipe(Effect.repeat(Schedule.spaced("1 second")));
`;

const EXPONENTIAL_WITH_A_DEADLINE = `import { Effect, Schedule } from "effect";

export const retried = (work: Effect.Effect<void>) =>
  work.pipe(Effect.retry(Schedule.exponential("1 second")), Effect.timeout("30 seconds"));
export const repeated = (work: Effect.Effect<void>) =>
  work.pipe(Effect.repeat(Schedule.exponential("1 second")), Effect.timeout("30 seconds"));
export const retriedWithJitter = (work: Effect.Effect<void>) =>
  work.pipe(Effect.retry(Schedule.jittered(Schedule.exponential("1 second"))), Effect.timeout("30 seconds"));
export const repeatedWithJitter = (work: Effect.Effect<void>) =>
  work.pipe(Effect.repeat(Schedule.exponential("1 second").pipe(Schedule.jittered)), Effect.timeout("30 seconds"));
`;

const EXPONENTIAL_WITHOUT_A_DEADLINE = `import { Effect, Schedule } from "effect";

export const retried = (work: Effect.Effect<void>) => Effect.retry(work, Schedule.exponential("1 second"));
export const repeated = (work: Effect.Effect<void>) => Effect.repeat(work, Schedule.exponential("1 second"));
`;

const EXPONENTIAL_IN_A_TIMEOUT_FALLBACK = `import { Effect, Schedule } from "effect";

export const retried = (work: Effect.Effect<void>) =>
  Effect.timeoutOrElse(work, { duration: "30 seconds", orElse: () => Effect.retry(work, Schedule.exponential("1 second")) });
export const repeated = (work: Effect.Effect<void>) =>
  work.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.repeat(work, Schedule.exponential("1 second")) }));
`;

export const testsPollOutsideSystemsOnlyWhenGrantedSchedules = Task.make(
  "a test without a grant may not time out or poll on a timer, a test granted pollsWithADeadline may repeat or retry with Schedule.spaced bounded by a timeout but not without one, and tests may move TestClock and retry a counted Schedule.recurs",
  Effect.gen(function* () {
    const ungranted = yield* lintWithPermissions("{}", {
      "tests/polls.ts": POLLS_WITH_A_DEADLINE,
      "tests/virtual-time.ts": MOVES_VIRTUAL_TIME,
    });
    expect(ungranted).not.toContain("virtual-time.ts");
    expect(ungranted).toContain("Schedule.spaced polls on a timer");
    expect(ungranted).toContain("Effect.timeout sets a deadline inside a test");
    expect(
      yield* lintWithPermissions('{ "tests/polls.ts": { allow: ["pollsWithADeadline"] } }', {
        "tests/polls.ts": POLLS_WITH_A_DEADLINE,
      }),
    ).toBe("");
    const unbounded = yield* lintWithPermissions(
      '{ "tests/polls.ts": { allow: ["pollsWithADeadline"] } }',
      {
        "tests/polls.ts": POLLS_WITHOUT_A_DEADLINE,
      },
    );
    expect(unbounded).toContain("Schedule.spaced polls without a deadline");
    expect(
      yield* lintWithPermissions('{ "tests/retries.ts": { allow: ["pollsWithADeadline"] } }', {
        "tests/retries.ts": RETRIES_WITH_A_DEADLINE,
      }),
    ).toBe("");
    expect(unbounded).not.toContain("no-test-timeouts");
  }).pipe(Effect.scoped),
);

export const retriesOnATimerOnlyWhenGrantedSchedulesUnderADeadline = Task.make(
  "a file granted pollsWithADeadline may retry with Schedule.spaced bounded by a timeout but not without one nor at once with Schedule.recurs, and a file without the grant may not retry on a timer",
  Effect.gen(function* () {
    const granted = '{ "retries.ts": { allow: ["pollsWithADeadline"] } }';
    expect(yield* lintWithPermissions(granted, { "retries.ts": RETRIES_WITH_A_DEADLINE })).toBe("");
    expect(
      yield* lintWithPermissions(granted, { "retries.ts": RETRIES_WITHOUT_A_DEADLINE }),
    ).toContain("Schedule.spaced polls without a deadline");
    expect(yield* lintWithPermissions(granted, { "retries.ts": RETRIES_AT_ONCE })).toContain(
      "Effect.retry retries at once, with no wait between attempts",
    );
    expect(yield* lintWithPermissions("{}", { "retries.ts": RETRIES_WITH_A_DEADLINE })).toContain(
      "Schedule.spaced retries on a timer",
    );
  }).pipe(Effect.scoped),
);

export const exponentialSchedulesNeedAGrantAndADeadline = Task.make(
  "a file granted pollsWithADeadline may repeat or retry with an exponential schedule, optionally jittered, under a deadline but not without one or in its uncovered fallback, and ungranted files may not use exponential schedules",
  Effect.gen(function* () {
    const granted = '{ "exponential.ts": { allow: ["pollsWithADeadline"] } }';
    expect(
      yield* lintWithPermissions(granted, { "exponential.ts": EXPONENTIAL_WITH_A_DEADLINE }),
    ).toBe("");
    const unbounded = yield* lintWithPermissions(granted, {
      "exponential.ts": EXPONENTIAL_WITHOUT_A_DEADLINE,
    });
    expect(unbounded).toContain("Schedule.exponential polls without a deadline");
    expect(unbounded).not.toContain("retries at once");
    expect(
      yield* lintWithPermissions(granted, { "exponential.ts": EXPONENTIAL_IN_A_TIMEOUT_FALLBACK }),
    ).toContain("Schedule.exponential polls without a deadline");
    const ungranted = yield* lintWithPermissions("{}", {
      "exponential.ts": EXPONENTIAL_WITH_A_DEADLINE,
    });
    expect(ungranted).toContain("Schedule.exponential retries on a timer");
    expect(ungranted).toContain("Schedule.exponential polls on a timer");
    expect(ungranted).toContain("Schedule.jittered retries on a timer");
    expect(ungranted).toContain("Schedule.jittered polls on a timer");
  }).pipe(Effect.scoped),
);

const WAITS_ON_TIMERS = `import { Clock, Effect, Stream } from "effect";

export const paused = Effect.sleep("1 second");
export const pausedByTheClock = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  yield* clock.sleep("1 second");
});
export const later = Effect.void.pipe(Effect.delay("1 second"));
export const ticks = Stream.tick("1 second");
export const settled = Stream.make("a", "b").pipe(Stream.debounce("1 second"));
export const paced = Stream.make("a", "b").pipe(
  Stream.throttle({ cost: (items) => items.length, units: 1, duration: "1 second" }),
);
export const pacedByEffect = Stream.make("a", "b").pipe(
  Stream.throttleEffect({ cost: (items) => Effect.succeed(items.length), units: 1, duration: "1 second" }),
);
`;

const TIMER_OPERATIONS = [
  "Effect.sleep",
  "Effect.delay",
  "Stream.tick",
  "Stream.debounce",
  "Stream.throttle",
  "Stream.throttleEffect",
  "Clock.sleep",
] as const;

export const timersWaitOnlyInFilesGrantedTimers = Task.make(
  "a file granted waitsOnTimers may sleep, delay, sleep through the Clock service and use the Stream operations that wait on a timer, a file without the grant may not, and the grant lifts neither clock reads nor timed schedules",
  Effect.gen(function* () {
    const ungranted = yield* lintWithPermissions("{}", { "src/timers.ts": WAITS_ON_TIMERS });
    for (const operation of TIMER_OPERATIONS) {
      expect(ungranted).toContain(`${operation} is banned`);
    }
    expect(
      yield* lintWithPermissions('{ "src/timers.ts": { allow: ["waitsOnTimers"] } }', {
        "src/timers.ts": WAITS_ON_TIMERS,
      }),
    ).toBe("");
    const stillBanned = yield* lintWithPermissions(
      '{ "src/timers.ts": { allow: ["waitsOnTimers"] } }',
      {
        "src/timers.ts": `import { Schedule } from "effect";
${WAITS_ON_TIMERS}export const now = new Date();
export const polled = Effect.void.pipe(Effect.repeat(Schedule.spaced("1 second")));
`,
      },
    );
    expect(stillBanned).toContain("new Date() reads the current time");
    expect(stillBanned).toContain("Schedule.spaced polls on a timer");
    for (const operation of TIMER_OPERATIONS) {
      expect(stillBanned).not.toContain(`${operation} is banned`);
    }
  }).pipe(Effect.scoped),
);

export const malformedGrantsAreRefusedAtRuntime = Task.make(
  "check decodes the grants with one Schema and names every malformed path, unknown permission or key, empty or repeated list, empty grant and Markdown grant beyond its file type together when the config loads",
  Effect.gen(function* () {
    const refusals = [
      {
        permissionsByFile: '{ "src/*.ts": { allow: ["usesSqlDatabases"] } }',
        refusal: 'oxlint.config.ts: error MalformedGrant: "src/*.ts": is a glob',
      },
      {
        permissionsByFile: '{ "src/{a,b}.ts": { allow: ["usesSqlDatabases"] } }',
        refusal: '"src/{a,b}.ts": is a glob',
      },
      {
        permissionsByFile: '{ "!a.ts": { allow: ["usesSqlDatabases"] } }',
        refusal: '"!a.ts": is a negated pattern',
      },
      {
        permissionsByFile: '{ "/a.ts": { allow: ["usesSqlDatabases"] } }',
        refusal: '"/a.ts": is an absolute path',
      },
      {
        permissionsByFile: '{ "../a.ts": { allow: ["usesSqlDatabases"] } }',
        refusal: '"../a.ts": has a .. segment',
      },
      {
        permissionsByFile: '{ "./a.ts": { allow: ["usesSqlDatabases"] } }',
        refusal: '"./a.ts": is not a normalized path',
      },
      {
        permissionsByFile:
          '{ "docs/a.md": { allow: ["hasAnUnlistedFileType", "usesSqlDatabases"] } }',
        refusal: '"docs/a.md": is Markdown, so it may only be granted hasAnUnlistedFileType',
      },
      {
        permissionsByFile: '{ "a.ts": { allow: ["everything"] } }',
        refusal: ['"a.ts".allow[0]: Expected "readsConfig"', 'got "everything"'].join("\n"),
      },
      {
        permissionsByFile:
          '{ "a.ts": { allow: [{ trustsUnverifiedTypes: "ports cross threads" }] } }',
        refusal: '"a.ts".allow[0]: is not a permission name',
      },
      {
        permissionsByFile:
          '{ "a.ts": { allow: [{ handlesEveryFailure: "reports every outcome" }] } }',
        refusal: '"a.ts".allow[0]: is not a permission name',
      },
      {
        permissionsByFile: '{ "a.ts": { allow: [1] } }',
        refusal: '"a.ts".allow[0]: is not a permission name',
      },
      {
        permissionsByFile:
          '{ "a.ts": { allow: ["trustsUnverifiedTypes", "trustsUnverifiedTypes"] } }',
        refusal: '"a.ts".allow: lists "trustsUnverifiedTypes" twice',
      },
      {
        permissionsByFile:
          '{ "a.ts": { allow: ["usesSqlDatabases"], reason: "queries the cache" } }',
        refusal: '"a.ts".reason: is not one of the grant keys allow, services, cannotImport',
      },
      {
        permissionsByFile: '{ "a.ts": { allow: ["trustsUnverifiedTypes", "isGeneratedByATool"] } }',
        refusal:
          '"a.ts": generated outputs cannot also have permissions, services or import restrictions',
      },
      ...[
        "arguments",
        "syncWrites",
        "file-location",
        "typeGuardSchemas",
        "console",
        "shortNames",
        "file-type",
        "config",
        "commandSpawn",
        "syncReads",
        "document",
        "fileType",
        "directory",
        "hasAFileTypeCheckRefuses",
        "isADirectoryCheckRefuses",
      ].map((name) => ({
        permissionsByFile: `{ "a.ts": { allow: ["${name}"] } }`,
        refusal: ['"a.ts".allow[0]: Expected "readsConfig"', `got "${name}"`].join("\n"),
      })),
      {
        permissionsByFile: '{ "a-errors.ts": { allow: ["errors"] } }',
        refusal:
          '"a-errors.ts".allow[0]: errors is retired: error classes may be declared in any file',
      },
      {
        permissionsByFile: '{ "scripts/ci.ts": { allow: ["script"] } }',
        refusal:
          '"scripts/ci.ts".allow[0]: script is retired: files directly in scripts/ run tasks',
      },
      {
        permissionsByFile: '{ "a.ts": { allow: ["services"] } }',
        refusal: ['"a.ts".allow[0]: Expected "readsConfig"', 'got "services"'].join("\n"),
      },
      {
        permissionsByFile: '{ "a.ts": { allow: [] } }',
        refusal: '"a.ts".allow: is empty',
      },
      {
        permissionsByFile: '{ "a.ts": { services: [] } }',
        refusal: '"a.ts".services: is empty',
      },
      {
        permissionsByFile: '{ "a.ts": {} }',
        refusal: '"a.ts": grants nothing',
      },
      {
        permissionsByFile: '{ "a.ts": ["sql"] }',
        refusal: '"a.ts": Expected object, got ["sql"]',
      },
      {
        permissionsByFile: '{ "a.ts": { allow: ["usesSqlDatabases"], files: ["b.ts"] } }',
        refusal: '"a.ts".files: is not one of the grant keys allow, services, cannotImport',
      },
      {
        permissionsByFile: '{ "": { allow: ["usesSqlDatabases"] } }',
        refusal: '"": is not a path',
      },
      {
        permissionsByFile: '{ "src\\\\a.ts": { allow: ["usesSqlDatabases"] } }',
        refusal: '"src\\a.ts": uses backslashes',
      },
      {
        permissionsByFile: '{ "src/": { cannotImport: ["lib"] } }',
        refusal: '"src/": is not a normalized path',
      },
      {
        permissionsByFile: '{ "src": { cannotImport: ["lib/", "lib/*", "/lib", "../lib"] } }',
        refusal: [
          '"src".cannotImport[0]: is not a normalized path',
          '"src".cannotImport[1]: is a glob',
          '"src".cannotImport[2]: is an absolute path',
          '"src".cannotImport[3]: has a .. segment',
        ].join("\n"),
      },
      {
        permissionsByFile: '{ "src/worker": { cannotImport: ["src/worker", "src"] } }',
        refusal: [
          '"src/worker".cannotImport: "src/worker" contains "src/worker"',
          '"src/worker".cannotImport: "src" contains "src/worker"',
        ].join("\n"),
      },
      {
        permissionsByFile: '{ "src": { cannotImport: [] } }',
        refusal: '"src".cannotImport: is empty',
      },
      {
        permissionsByFile: '{ "src": { cannotImport: ["lib", "lib", 1] } }',
        refusal: [
          '"src".cannotImport[2]: Expected string, got 1',
          '"src".cannotImport: lists "lib" twice',
        ].join("\n"),
      },
      {
        permissionsByFile: '{ "src": { cannotImport: "lib" } }',
        refusal: '"src".cannotImport: Expected array, got "lib"',
      },
      {
        permissionsByFile:
          '{ "docs/a.md": { allow: ["hasAnUnlistedFileType"], cannotImport: ["src"] } }',
        refusal: '"docs/a.md": is Markdown, so it may only be granted hasAnUnlistedFileType',
      },
      {
        permissionsByFile: '{ "src/*.ts": { allow: ["sqll"], servics: ["Store"] } }',
        refusal: [
          '"src/*.ts": is a glob',
          '"src/*.ts".servics: is not one of the grant keys allow, services, cannotImport',
          '"src/*.ts".allow[0]: Expected "readsConfig"',
        ].join("\n"),
      },
      {
        permissionsByFile:
          '{ "a.ts": { allow: ["usesSqlDatabases", "usesSqlDatabases"], services: ["Store", "Store", ""] } }',
        refusal: [
          '"a.ts".allow: lists "usesSqlDatabases" twice',
          '"a.ts".services: lists "Store" twice',
          '"a.ts".services[2]: Expected a value with a length of at least 1, got ""',
        ].join("\n"),
      },
      {
        permissionsByFile:
          '{ "src/*.ts": { allow: ["sqll"] }, "docs/a.md": { allow: ["usesSqlDatabases"] }, "b.ts": { allow: ["hasAnUnlistedFileType", "hasAnUnlistedFileType"] } }',
        refusal: [
          '"src/*.ts": is a glob',
          '"docs/a.md": is Markdown, so it may only be granted hasAnUnlistedFileType',
          '"b.ts".allow: lists "hasAnUnlistedFileType" twice',
        ].join("\n"),
      },
      {
        permissionsByFile: '{ "a.ts": { allow: [""] } }',
        refusal: '"a.ts".allow[0]: Expected "readsConfig"',
      },
      {
        permissionsByFile: '{ "README.MD": { allow: ["usesSqlDatabases"] } }',
        refusal: '"README.MD": is Markdown, so it may only be granted hasAnUnlistedFileType',
      },
      {
        permissionsByFile: '{ "docs/a.md": { services: ["Store"] } }',
        refusal: '"docs/a.md": is Markdown, so it may only be granted hasAnUnlistedFileType',
      },
      {
        permissionsByFile: '{ "docs/a.md": { cannotImport: ["src"] } }',
        refusal: '"docs/a.md": is Markdown, so it may only be granted hasAnUnlistedFileType',
      },
    ];
    for (const { permissionsByFile, refusal } of refusals) {
      const output = yield* lintWithPermissions(permissionsByFile, {
        "a.ts": "export const A = 1;\n",
      });
      for (const line of refusal.split("\n")) {
        expect(output).toContain(line);
      }
    }
  }).pipe(Effect.scoped),
);

export const rootGrantsDoNotReachNestedFilesOfTheSameName = Task.make(
  "a grant for a root file leaves a nested file of the same name restricted",
  Effect.gen(function* () {
    const database =
      'import { Effect } from "effect";\nimport { SqlClient } from "effect/sql/SqlClient";\n\nexport const DATABASE = Effect.map(SqlClient, (client) => client);\n';
    const output = yield* lintWithPermissions('{ "db.ts": { allow: ["usesSqlDatabases"] } }', {
      "db.ts": database,
      "src/db.ts": database,
    });
    expect(output).toContain("src/db.ts:2:27: error sshkeda(no-sql-clients)");
    expect(output).not.toContain("\ndb.ts:2:27: error sshkeda(no-sql-clients)");
  }).pipe(Effect.scoped),
);

export const routeGrantsMatchOnlyTheLiteralFile = Task.make(
  "a grant for a route parameter path lifts its ban only on that literal file and leaves a file matching its glob characters banned",
  Effect.gen(function* () {
    const source = "export const stop = () => process.exit(1);\n";
    const output = yield* lintWithPermissions(
      '{ "src/[slug]/output.ts": { allow: ["exitsTheProcess"] } }',
      { "src/[slug]/output.ts": source, "src/s/output.ts": source },
    );
    expect(
      output.split("\n").filter((line) => line.includes("error sshkeda(no-process-exit)")),
    ).toEqual([
      "src/s/output.ts:1:27: error sshkeda(no-process-exit): process.exit exits the process directly",
    ]);
  }).pipe(Effect.scoped),
);

export const unpermittedFilesKeepEveryRestriction = Task.make(
  "files without a permission keep every restriction",
  Effect.gen(function* () {
    const output = yield* lintWithPermissions(`{ "permitted.ts": ${ALL_PERMISSIONS} }`, {
      "unpermitted.ts": PERMITTED,
    });
    expect(output).toContain("declares service Store outside a services file");
    expect(output).toContain("dynamic import() is banned");
    expect(output).toContain("ChildProcess from effect/process starts a command directly");
    expect(output).toContain("createRequire from node:module is banned");
    expect(output).toContain("Schema.declare declares a type nothing verifies");
    expect(output).toContain("Effect.exit handles failures it does not name");
    expect(output).toContain("Effect.all turns each failure into a result");
    expect(output).toContain("`input is number` is an unchecked type predicate");
    expect(output).toContain(
      "effect/sql/SqlClient uses a SQL client outside a usesSqlDatabases file",
    );
    expect(output).toContain("Schedule.spaced polls on a timer");
    expect(output).toContain("Config.int reads configuration");
    expect(output).toContain("process.env reads configuration");
    expect(output).toContain("process.argv reads configuration");
    expect(output).toContain("Bun.spawn starts a command directly");
    expect(output).toContain("spawn from node:child_process starts a command directly");
    expect(output).toContain("process.exit exits the process directly");
    expect(output).toContain("constants from node:fs reaches the file system directly");
    expect(output).toContain("open from node:fs/promises reaches the file system directly");
  }).pipe(Effect.scoped),
);

export const errorClassesMayLiveInAnyFile = Task.make(
  "a tagged error class may be declared in a file of any name",
  Effect.gen(function* () {
    const output = yield* lintWithPermissions("{}", {
      "src/store.ts":
        'import { Schema } from "effect";\n\nexport class Missing extends Schema.TaggedError<Missing>()("Missing", {}) {}\n',
    });
    expect(output).not.toContain("src/store.ts");
  }).pipe(Effect.scoped),
);

const LOCKS_A_FILE = `import { constants, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { constants as bunConstants } from "bun:fs";
import { open as bunOpen } from "bun:fs/promises";
import { constants as bareConstants } from "fs";
import { open as bareOpen } from "fs/promises";
import { join } from "node:path";
export const locked = () => open("trace.lock", constants.O_RDWR);
export const aliased = () => [bunOpen, bunConstants, bareOpen, bareConstants];
export const read = () => readFileSync(join("trace", "log"));
export const write = () => writeFileSync("trace.log", "line");
`;

const REACHES_THE_FILE_SYSTEM_BEYOND_A_LOCK = `import { stat } from "node:fs/promises";
import { watch } from "node:fs";
import { open } from "bun:fs";
import { readFile } from "bun:fs/promises";
import { promises } from "fs";
import { mkdir } from "fs/promises";
export const changedAt = async () => (await stat("trace.log", { bigint: true })).ctimeNs;
export const watched = () => [watch("trace.log"), open, readFile, promises, mkdir];
`;

export const lockingFilesAllowsOnlyOpenAndConstants = Task.make(
  "locksFiles allows only open from node:fs/promises and constants from node:fs, under any of their names, while the rest of node:fs and node:fs/promises under any of their names, other built-ins and synchronous file access stay banned",
  Effect.gen(function* () {
    const ungranted = yield* lintWithPermissions("{}", { "lock.ts": LOCKS_A_FILE });
    for (const usage of [
      "open from node:fs/promises",
      "constants from node:fs",
      "constants from bun:fs",
      "open from bun:fs/promises",
      "constants from fs",
      "open from fs/promises",
    ]) {
      expect(ungranted).toContain(`${usage} reaches the file system directly`);
    }
    const granted = yield* lintWithPermissions('{ "lock.ts": { allow: ["locksFiles"] } }', {
      "lock.ts": LOCKS_A_FILE,
    });
    expect(granted).not.toContain("reaches the file system directly");
    expect(granted).not.toContain("in a way no file may");
    expect(granted).toContain("importing node:path is banned");
    expect(granted).toContain("writeFileSync from node:fs reaches the file system synchronously");
    expect(granted).toContain("readFileSync from node:fs reaches the file system synchronously");
    const beyond = yield* lintWithPermissions('{ "watcher.ts": { allow: ["locksFiles"] } }', {
      "watcher.ts": REACHES_THE_FILE_SYSTEM_BEYOND_A_LOCK,
    });
    for (const module of [
      "node:fs/promises",
      "node:fs",
      "bun:fs",
      "bun:fs/promises",
      "fs",
      "fs/promises",
    ]) {
      expect(beyond).toContain(
        `${module} reaches the file system in a way no file may; use the Effect FileSystem service, or take a file lock with open from node:fs/promises and constants from node:fs in a file allowed locksFiles`,
      );
    }
  }).pipe(Effect.scoped),
);

const LOADS_THROUGH_A_CREATED_REQUIRE = `import type * as ChildProcesses from "node:child_process";
import { createRequire } from "node:module";

const load: (id: string) => typeof ChildProcesses = createRequire(import.meta.url);
load("node:child_process").exec("echo hi");
`;

const WRITES_THROUGH_NODE_CONSOLE = `import { log } from "node:console";
import terminal from "console";
import * as bunTerminal from "bun:console";

log("x");
terminal.error("x");
new bunTerminal.Console(stream).log("x");
`;

export const createdRequiresAndNodeConsoleStayBanned = Task.make(
  "a file granted every permission may not load a module through the require createRequire returns, and no file may write through node:console under any of its names",
  Effect.gen(function* () {
    const loads = yield* lintWithPermissions(`{ "load.ts": ${ALL_PERMISSIONS} }`, {
      "load.ts": LOADS_THROUGH_A_CREATED_REQUIRE,
    });
    expect(loads).toContain("a require createRequire returns loads code in a way no file may");
    for (const permissions of ["{}", `{ "write.ts": ${ALL_PERMISSIONS} }`]) {
      const writes = yield* lintWithPermissions(permissions, {
        "write.ts": WRITES_THROUGH_NODE_CONSOLE,
      });
      for (const module of ["node:console", "console", "bun:console"]) {
        expect(writes).toContain(`${module} writes to the terminal in a way no file may`);
      }
    }
  }).pipe(Effect.scoped),
);

const BEYOND_EVERY_ALLOW_LIST = `import { Console, Effect, Schedule } from "effect";
import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Script } from "node:vm";

export const database = () => new Database("store.sqlite");
export const run = () => [execSync("ls"), Bun.spawnSync(["ls"]), Bun.$\`ls\`];
export const commandLine = () => [process.argv0, Bun.env, parseArgs({})];
export const loaded = () => [import.meta.require("./a.ts"), new Script("1")];
export const greet = Console.log("hi");
export const written = () => process.stdout.write("hi");
export const polled = (work: Effect.Effect<void>) =>
  work.pipe(Effect.repeat(Schedule.fibonacci("1 second")), Effect.timeout("30 seconds"));
`;

export const noGrantLiftsWhatAPermissionDoesNotAllow = Task.make(
  "a file granted every permission still may not use the APIs no permission allows: other SQL clients, other ways to start commands, raw argument readers, import.meta.require and node:vm, Effect Console, process.stdout and timed schedules such as Schedule.fibonacci",
  Effect.gen(function* () {
    const output = yield* lintWithPermissions(`{ "beyond.ts": ${ALL_PERMISSIONS} }`, {
      "beyond.ts": BEYOND_EVERY_ALLOW_LIST,
    });
    for (const report of [
      "bun:sqlite is a SQL client no file may use",
      "node:child_process starts a command in a way no file may",
      "Bun.spawnSync starts a command in a way no file may",
      "Bun.$ starts a command in a way no file may",
      "process.argv0 reads configuration, which no file may do",
      "Bun.env reads configuration, which no file may do",
      "parseArgs from node:util reads configuration, which no file may do",
      "import.meta.require loads code in a way no file may",
      "node:vm loads code in a way no file may",
      "Console.log writes to the terminal in a way no file may",
      "process.stdout writes to the terminal in a way no file may",
      "Schedule.fibonacci is a timed schedule no file may use",
    ]) {
      expect(output).toContain(report);
    }
  }).pipe(Effect.scoped),
);

export const servicePermissionsNameEachService = Task.make(
  "a services grant allows exactly the named services in each file",
  Effect.gen(function* () {
    const unlisted = yield* lintWithPermissions('{ "permitted.ts": { services: ["Cache"] } }', {
      "permitted.ts": PERMITTED,
    });
    expect(unlisted).toContain("declares unlisted service Store");
    expect(unlisted).toContain("granted service Cache is not declared here");
    const merged = yield* lintWithPermissions(
      '{ "permitted.ts": { services: ["Store", "Cache"] } }',
      {
        "permitted.ts": `${PERMITTED}export class Cache extends Context.Reference<Cache>()("Cache", { defaultValue: () => 1 }) {}\n`,
      },
    );
    expect(merged).not.toContain("declares unlisted service");
    expect(merged).not.toContain("is not declared here");
  }).pipe(Effect.scoped),
);

export const unknownPermissionsFailTypeChecking = Task.make(
  "TypeScript rejects unknown permission names and keys and a file granted twice",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const repository = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const plugin = yield* encodeJson(path.join(repository, "src/index.ts"));
    yield* fileSystem.symlink(
      path.join(repository, "node_modules"),
      path.join(directory, "node_modules"),
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "tsconfig.json"),
      yield* encodeJson({ extends: path.join(repository, "tsconfig.json"), include: ["*.ts"] }),
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "known.ts"),
      `import { lintConfig } from ${plugin};\nexport const fromCode = (names: ReadonlyArray<"usesSqlDatabases" | "writesToTheTerminal">) => lintConfig({ "a.ts": { allow: names } });\nexport const known = lintConfig({ "a.ts": { allow: ["spawnsCommands", "usesSqlDatabases", "writesToTheTerminal", "locksFiles", "pollsWithADeadline"], services: ["Store"] } });\n`,
    );
    yield* Task.exec(path.join(repository, "node_modules/.bin/tsc"), [
      "--noEmit",
      "--project",
      path.join(directory, "tsconfig.json"),
    ]);
    yield* fileSystem.writeFileString(
      path.join(directory, "unknown.ts"),
      `import { lintConfig } from ${plugin};\nexport const unknown = lintConfig({ "a.ts": { allow: ["everything"] } });\nexport const unnamedServices = lintConfig({ "a.ts": { allow: ["services"] } });\nexport const unknownKey = lintConfig({ "a.ts": { deny: ["usesSqlDatabases"] } });\nexport const grantsNothing = lintConfig({ "a.ts": {} });\nexport const grantedTwice = lintConfig({ "a.ts": { allow: ["usesSqlDatabases"] }, "a.ts": { allow: ["writesToTheTerminal"] } });\nexport const retired = lintConfig({ "a.ts": { allow: ["errors"] } });\n`,
    );
    const failure = yield* Task.exec(path.join(repository, "node_modules/.bin/tsc"), [
      "--noEmit",
      "--project",
      path.join(directory, "tsconfig.json"),
    ]).pipe(failureAsValue);
    expect(failure.message).toContain("unknown.ts");
    expect(failure.message).toContain('"everything"');
    expect(failure.message).toContain('"services"');
    expect(failure.message).toContain("multiple properties with the same name");
    expect(failure.message).toContain("deny");
    expect(failure.message).toContain("unknown.ts(5,");
  }).pipe(Effect.scoped),
);

export const scriptsRunTasksByPosition = Task.make(
  "a file directly in scripts/ runs tasks with no grant, while a file under a subdirectory of scripts/ or in src/ may not",
  Effect.gen(function* () {
    const runsATask =
      'import { Task } from "@sshkeda/task";\nimport { Effect } from "effect";\nTask.main(Task.make("runs", Effect.void));\n';
    const output = yield* lintWithPermissions("{}", {
      "scripts/ci.ts": runsATask,
      "scripts/shared/helper.ts": runsATask,
      "src/main.ts": runsATask,
    });
    expect(
      output
        .split("\n")
        .filter((line) => line.includes("sshkeda(no-task-main)"))
        .map((line) => line.slice(0, line.indexOf(":")))
        .toSorted(),
    ).toEqual(["scripts/shared/helper.ts", "src/main.ts"]);
  }).pipe(Effect.scoped),
);

const DECLARES_A_SCHEMA_FROM_A_GUARD = `import { Schema } from "effect";

export const Port = Schema.declare((input): input is 80 => input === 80);
export const isPort = (value: number): value is 80 => value === 80;
`;

export const unverifiedTypesLiftsOnlyThePredicateOfASchemaDeclaration = Task.make(
  "without a grant, a Schema.declare callback's type predicate is refused by both bans, and a file granted trustsUnverifiedTypes may keep that predicate while every other type predicate in it stays refused",
  Effect.gen(function* () {
    const ungranted = yield* lintWithPermissions("{}", {
      "port.ts": DECLARES_A_SCHEMA_FROM_A_GUARD,
    });
    expect(ungranted).toContain("Schema.declare declares a type nothing verifies");
    expect(ungranted).toContain("`input is 80` is an unchecked type predicate");
    expect(ungranted).toContain("`value is 80` is an unchecked type predicate");
    const granted = yield* lintWithPermissions(
      '{ "port.ts": { allow: ["trustsUnverifiedTypes"] } }',
      {
        "port.ts": DECLARES_A_SCHEMA_FROM_A_GUARD,
      },
    );
    expect(granted).not.toContain("declares a type nothing verifies");
    expect(granted).not.toContain("`input is 80`");
    expect(granted).toContain("`value is 80` is an unchecked type predicate");
  }).pipe(Effect.scoped),
);

const HANDLES_EVERY_FAILURE = `import { Deferred, Effect, Fiber, Stream } from "effect";
import { exit as outcome } from "effect/Effect";
export const settled = (work: Effect.Effect<number, string>) => Effect.exit(work);
export const recovered = (work: Effect.Effect<number, string>) => work.pipe(Effect.catch(() => Effect.succeed(0)));
export const matched = (work: Effect.Effect<number, string>) => work.pipe(Effect.matchEffect({ onFailure: () => Effect.succeed(0), onSuccess: Effect.succeed }));
export const all = (works: readonly Effect.Effect<number, string>[]) => Effect.all(works, { mode: "result" });
export const awaited = (fiber: Fiber.Fiber<number, string>) => Fiber.await(fiber);
export const results = (stream: Stream.Stream<number, string>) => stream.pipe(Stream.result);
export const aliased = outcome;
export const flipped = (work: Effect.Effect<number, string>) => work.pipe(Effect.flip);
export const stored = (deferred: Deferred.Deferred<number, string>, work: Effect.Effect<number, string>) => Deferred.complete(deferred, work);
export const observed = (fiber: Fiber.Fiber<number, string>) => fiber.addObserver(() => undefined);
export const fallenBack = (work: Effect.Effect<number, string>) => Effect.catchTags(work, {}, () => Effect.succeed(0));
`;

export const handlesEveryFailureLiftsTheUnnamedRecoveryBans = Task.make(
  "without a grant, every operation that turns a failure it does not name into a success or a value is refused, and a file granted handlesEveryFailure may use all of them while orDie stays refused",
  Effect.gen(function* () {
    const ungranted = yield* lintWithPermissions("{}", { "edge.ts": HANDLES_EVERY_FAILURE });
    for (const usage of [
      "Effect.exit",
      "Effect.catch",
      "Effect.matchEffect",
      "Fiber.await",
      "Stream.result",
      "Effect.flip",
      "Deferred.complete",
      "addObserver",
    ]) {
      expect(ungranted).toContain(`${usage} handles failures it does not name`);
    }
    expect(ungranted).toContain("Effect.all turns each failure into a result");
    expect(ungranted).toContain(
      "Effect.catchTags is given a fallback for failures it does not name",
    );
    const granted = yield* lintWithPermissions(
      '{ "edge.ts": { allow: ["handlesEveryFailure"] } }',
      {
        "edge.ts": `${HANDLES_EVERY_FAILURE}export const crashed = Effect.orDie(Effect.fail(1));\n`,
      },
    );
    expect(granted).not.toContain("handles failures it does not name");
    expect(granted).not.toContain("turns each failure into a result");
    expect(granted).not.toContain("is given a fallback");
    expect(granted).toContain("Effect.orDie is banned");
  }).pipe(Effect.scoped),
);
