import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Array as Arrays, flow } from "effect";

import { findUngrantedStdioUses } from "../../src/lib/tasks/lib/confine-stdio-to-granted-files/internal/find-ungranted-stdio-uses.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const READS_ARGUMENTS = `import { Effect, Stdio } from "effect";
export const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.args;
});
`;

const ARGUMENT_READS = {
  "direct.ts": READS_ARGUMENTS,
  "parameter.ts": `import type { Stdio } from "effect";
export const argumentsOf = (service: Stdio.Stdio) => service.args;
`,
  "destructured.ts": `import type { Stdio } from "effect";
export const argumentsOf = ({ args: commandLine }: Stdio.Stdio) => commandLine;
`,
  "used.ts": `import { Stdio } from "effect";
export const program = Stdio.Stdio.use(({ args }) => args);
`,
  "generic.ts": `import type { Stdio } from "effect";
export const argumentsOf = <Service extends Stdio.Stdio>(service: Service) => service.args;
`,
  "flat-mapped.ts": `import { Effect } from "effect";
import { Stdio } from "effect/Stdio";
export const commandLineArguments = Effect.flatMap(Stdio, (stdio) => stdio.args);
`,
  "yielded-destructured.ts": `import { Effect, Stdio } from "effect";
export const program = Effect.gen(function* () {
  const { args } = yield* Stdio.Stdio;
  return yield* args;
});
`,
  "element.ts": `import type { Stdio } from "effect";
export const argumentsOf = (service: Stdio.Stdio) => service["args"];
`,
  "console.ts": READS_ARGUMENTS,
  "quoted-key.ts": `import type { Stdio } from "effect";
export const argumentsOf = ({ "args": commandLine }: Stdio.Stdio) => commandLine;
`,
  "computed-key.ts": `import type { Stdio } from "effect";
export const argumentsOf = ({ ["args"]: commandLine }: Stdio.Stdio) => commandLine;
`,
  "constant-key.ts": `import type { Stdio } from "effect";
const KEY = "args";
export const argumentsOf = (service: Stdio.Stdio) => service[KEY];
`,
  "constant-computed-key.ts": `import type { Stdio } from "effect";
const KEY = "args";
export const argumentsOf = ({ [KEY]: commandLine }: Stdio.Stdio) => commandLine;
`,
  "generic-key.ts": `import type { Stdio } from "effect";
export const argumentsOf = <Key extends "args">(service: Stdio.Stdio, key: Key) => service[key];
`,
  "union.ts": `import type { Stdio } from "effect";
export const argumentsOf = (service: Stdio.Stdio | { readonly args: ReadonlyArray<string> }) => service.args;
`,
};

const WRITES_TO_THE_TERMINAL = `import { Effect, Stdio, Stream } from "effect";
export const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.run(Stream.make(new Uint8Array()), stdio.stdout());
  yield* Stream.run(Stream.make(new Uint8Array()), stdio.stderr());
});
`;

const TERMINAL_WRITES = {
  "direct-writes.ts": WRITES_TO_THE_TERMINAL,
  "used-writes.ts": `import { Stdio, Stream } from "effect";
export const program = Stdio.Stdio.use(({ stdout }) => Stream.run(Stream.make(), stdout()));
`,
  "element-writes.ts": `import type { Stdio } from "effect";
export const sinkOf = (service: Stdio.Stdio) => service["stderr"];
`,
  "constant-key-writes.ts": `import type { Stdio } from "effect";
const KEY = "stdout";
export const outputOf = (service: Stdio.Stdio) => service[KEY];
`,
  "generic-key-writes.ts": `import type { Stdio } from "effect";
export const sinkOf = <Key extends "stderr" | "stdout">(service: Stdio.Stdio, key: Key) => service[key];
`,
  "config-writes.ts": WRITES_TO_THE_TERMINAL,
};

const ALLOWED_USES = {
  "members.ts": `import { Effect, Layer, Stdio, Stream } from "effect";
declare const runtimeStdio: Stdio.Stdio;
export const SPREAD = Stdio.make({ ...runtimeStdio, stdin: Stream.empty });
export const LIVE = Layer.succeed(Stdio.Stdio, runtimeStdio);
export const input = Stdio.Stdio.use(({ stdin }) => Stream.runDrain(stdin));
export const terminal = Effect.map(Stdio.Stdio, (io) => io.stdinIsTerminal);
export const outputIsTerminal = Effect.flatMap(Stdio.Stdio, (io) => io.stdoutIsTerminal);
`,
  "unrelated.ts": `import type { Effect } from "effect";
export const parsed = { args: ["one"] };
export const { args } = parsed;
export const element = parsed["args"];
export const read = (service: { readonly args: Effect.Effect<ReadonlyArray<string>> }) => service.args;
`,
  "other-keys.ts": `import type { Stdio } from "effect";
const KEY = "stdin";
export const readOf = (service: Stdio.Stdio) => service[KEY];
export const inputOf = ({ ["stdin"]: input }: Stdio.Stdio) => input;
`,
  "config.ts": READS_ARGUMENTS,
  "console.ts": WRITES_TO_THE_TERMINAL,
};

const stdioUses = (sources: Readonly<Record<string, string>>) =>
  makeProject(
    sources,
    'lintConfig({ "config.ts": { allow: ["readsConfig"] }, "console.ts": { allow: ["writesToTheTerminal"] }, "config-writes.ts": { allow: ["readsConfig"] } })',
  ).pipe(
    Effect.flatMap(({ tsconfigFile }) =>
      findUngrantedStdioUses(tsconfigFile, openTypeScriptProjects(tsconfigFile)),
    ),
    Effect.as(new Array<string>()),
    Effect.catchTag("StdioUsesRefused", (failure) =>
      Effect.succeed(taggedViolations(failure.violations).toSorted()),
    ),
    Effect.scoped,
  );

export const stdioArgumentReadsAreRefused = Task.make(
  "outside files granted readsConfig, files granted writesToTheTerminal included, reading args from a value whose type is Effect's Stdio is refused, by property access, element access or object destructuring, with a literal, constant or generic key, on a union that includes Stdio, including in a Stdio.use or Effect.flatMap callback",
  Effect.gen(function* () {
    expect(yield* stdioUses(ARGUMENT_READS)).toEqual(
      [
        "computed-key.ts:2:29",
        "console.ts:4:17",
        "constant-computed-key.ts:3:29",
        "constant-key.ts:3:54",
        "destructured.ts:2:29",
        "direct.ts:4:17",
        "element.ts:2:54",
        "flat-mapped.ts:3:70",
        "generic-key.ts:2:84",
        "generic.ts:2:79",
        "parameter.ts:2:54",
        "quoted-key.ts:2:29",
        "union.ts:2:97",
        "used.ts:2:41",
        "yielded-destructured.ts:3:9",
      ].map(
        (location) =>
          `${location}: error StdioArgumentsReadWithoutGrant: Stdio.args reads configuration`,
      ),
    );
  }),
);

export const stdioTerminalWritesAreRefused = Task.make(
  "outside files granted writesToTheTerminal, files granted readsConfig included, reading the stdout or stderr sink from a value whose type is Effect's Stdio is refused, by property access, element access or destructuring, with a literal, constant or generic key",
  Effect.gen(function* () {
    expect(yield* stdioUses(TERMINAL_WRITES)).toEqual(
      [
        "config-writes.ts:4:52 stdout",
        "config-writes.ts:5:52 stderr",
        "constant-key-writes.ts:3:51 stdout",
        "direct-writes.ts:4:52 stdout",
        "direct-writes.ts:5:52 stderr",
        "element-writes.ts:2:49 stderr",
        "generic-key-writes.ts:2:92 stderr",
        "generic-key-writes.ts:2:92 stdout",
        "used-writes.ts:2:41 stdout",
      ].map((entry) => {
        const [location, member] = entry.split(" ");
        return `${location}: error StdioTerminalWriteWithoutGrant: Stdio.${member} writes to the terminal`;
      }),
    );
  }),
);

export const stdioUsesOtherThanArgumentReadsAreAllowed = Task.make(
  "stdin and the isTerminal checks, spreading Stdio into Stdio.make, providing it, args on a type that is not Stdio, args in files granted readsConfig and stdout or stderr in files granted writesToTheTerminal are allowed",
  Effect.gen(function* () {
    expect(yield* stdioUses(ALLOWED_USES)).toEqual([]);
  }),
);

export const terminalWritesNeedTheConsolePermission = Task.make(
  "no-terminal-writes refuses Effect Console, node:console under any of its names, process.stdout, process.stderr, Bun.stdout and Bun.stderr however they are reached, in every file, even one granted writesToTheTerminal, and leaves type imports, Effect.log, stdin and lookalikes alone",
  ruleTest("no-terminal-writes", {
    valid: [
      'import type { Console } from "effect"; type Sink = Console.Console;',
      'import { Effect } from "effect"; Effect.log("ready");',
      'import { Console } from "other"; Console.log("ready");',
      "process.stdin;",
      "Bun.stdin;",
      "const process = { stdout: { write: (line: string) => line } }; process.stdout.write('ready');",
      'import { stdout } from "./terminal.ts"; stdout.write("ready");',
    ],
    invalid: [
      'import { Console } from "effect"; Console.log("ready");',
      'import { Console as Terminal } from "effect"; Terminal.setConsole;',
      'import * as Console from "effect/Console"; Console.setConsole;',
      'import { log } from "effect/Console"; log("ready");',
      'import * as Effectful from "effect"; Effectful.Console.log("ready");',
      'import { Console } from "effect"; const { log } = Console;',
      'import * as Terminal from "effect/Console"; const { log: write } = Terminal;',
      'process.stdout.write("ready");',
      'process.stderr.write("failed");',
      'Bun.stdout.writer().write("ready");',
      'Bun.write(Bun.stderr, "failed");',
      "const { stdout } = process; stdout.write('ready');",
      'import { stderr } from "node:process"; stderr.write("failed");',
      'import { stdout } from "bun"; stdout.writer();',
      ...["node:console", "console", "bun:console"].flatMap((specifier) => [
        `import { log } from "${specifier}"; log("x");`,
        `import terminal from "${specifier}"; terminal.log("x");`,
        `import * as terminal from "${specifier}"; terminal.error("x");`,
        `import { Console } from "${specifier}"; new Console(stream).log("x");`,
      ]),
    ].flatMap((code) => [
      { code, errors: [{ messageId: "bannedEvenWhenGranted" }] },
      {
        code,
        options: [{ bans: "onlyThoseNoGrantLifts" }],
        errors: [{ messageId: "bannedEvenWhenGranted" }],
      },
    ]),
  }),
);

const STDIO = 'import { Effect, Layer, Stdio, Stream } from "effect";\n';

const usedForMore = (usage: string) => ({
  message: `${usage} is used for more than reading stdin, args or whether a stream is a terminal`,
});

export const stdioServiceNeedsTheTerminalOutputPermission = Task.make(
  "no-stdio-service refuses the Effect Stdio service yielded, used, mapped, piped, provided, stored or passed anywhere, a structural stand-in for its stdout included, and leaves a direct read of stdin, args or an isTerminal check, through yield*, use, an Effect map or flatMap, or the first step of a pipe, a type and Stdio.make alone",
  ruleTest("no-stdio-service", {
    valid: [
      `${STDIO}export const input = Stdio.Stdio.use(({ stdin }) => Stream.runDrain(stdin));`,
      `${STDIO}export const input = Stdio.Stdio.use((stdio) => Stream.runDrain(stdio.stdin));`,
      `${STDIO}export const program = Effect.gen(function* () { const stdio = yield* Stdio.Stdio; yield* Stream.runDrain(stdio.stdin); return yield* stdio.args; });`,
      `${STDIO}export const program = Effect.gen(function* () { return (yield* Stdio.Stdio).stdinIsTerminal; });`,
      `${STDIO}export const program = Effect.gen(function* () { const { args, stdoutIsTerminal } = yield* Stdio.Stdio; return [args, stdoutIsTerminal]; });`,
      `${STDIO}export const terminal = Effect.map(Stdio.Stdio, (io) => io.stderrIsTerminal);`,
      `${STDIO}export const commandLine = Effect.flatMap(Stdio.Stdio, ({ args }) => args);`,
      `${STDIO}export const service = Stdio.make(options);`,
      `${STDIO}export const program = Stdio.Stdio.pipe(Effect.flatMap((service) => service.args));`,
      'import { Effect, Stdio, pipe } from "effect"; export const program = pipe(Stdio.Stdio, Effect.flatMap((service) => service.args));',
      'import { Effect, Stdio } from "effect"; import { pipe } from "effect/Function"; export const program = pipe(Stdio.Stdio, Effect.map(({ stdinIsTerminal }) => stdinIsTerminal), Effect.map(String));',
      `${STDIO}export const program = Stdio.Stdio.pipe(Effect.map((service) => service.stdin), Effect.flatMap(Stream.runDrain));`,
      'import type { Stdio } from "effect"; export type Service = Stdio.Stdio;',
      'import { Stdio } from "other"; export const program = Stdio.Stdio.use(write);',
    ],
    invalid: [
      ...[
        `${STDIO}export const program = Stdio.Stdio.pipe(Effect.flatMap(write));`,
        `${STDIO}export const program = Stdio.Stdio.pipe(Effect.flatMap((service) => Stream.run(Stream.make("hello"), service.stdout())));`,
        `${STDIO}export const program = Stdio.Stdio.pipe(Effect.flatMap(Stdio.Stdio, (service) => service.args));`,
        `${STDIO}export const program = Stdio.Stdio.pipe(write);`,
        `${STDIO}export const program = Stdio.Stdio.pipe();`,
        'import { Effect, Stdio, pipe } from "effect"; export const program = pipe(Stdio.Stdio, Effect.flatMap(write));',
        'import { Effect, Stdio, pipe } from "effect"; export const program = pipe(Stdio.Stdio, (service) => service.stdout());',
        'import { Effect, Stdio } from "effect"; const pipe = (value, step) => step(value); export const program = pipe(Stdio.Stdio, Effect.flatMap((service) => service.args));',
        `${STDIO}export const program = Stdio.Stdio.pipe(Effect.tap((service) => service.stdoutIsTerminal), Effect.flatMap(write));`,
        'import { Effect, Stdio, pipe } from "effect"; export const program = pipe(Stdio.Stdio, Effect.tap((service) => service.stdoutIsTerminal), Effect.flatMap(write));',
        `${STDIO}export const program = Effect.tap(Stdio.Stdio, (service) => service.stdoutIsTerminal).pipe(Effect.flatMap(write));`,
      ].map((code) => ({ code, errors: [usedForMore("Stdio.Stdio")] })),
      {
        code: `${STDIO}const writeOutput = (service: { readonly "stdout": () => ReturnType<Stdio.Stdio["stdout"]> }) => Stream.run(Stream.make("hello"), service.stdout());\nexport const program = Stdio.Stdio.use(writeOutput);`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}const writeOutput = (service: Pick<Stdio.Stdio, "stdout">) => Stream.run(Stream.make("hello"), service.stdout());\nexport const program = Stdio.Stdio.use(writeOutput);`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const program = Stdio.Stdio.use((io) => Stream.run(Stream.make("hello"), io.stdout()));`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const program = Stdio.Stdio.use(({ stdin, stderr }) => Stream.run(stdin, stderr()));`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const program = Effect.gen(function* () { const stdio = yield* Stdio.Stdio; yield* Stream.run(stdio.stdin, stdio.stdout()); });`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const program = Effect.gen(function* () { const stdio = yield* Stdio.Stdio; return write(stdio); });`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const program = Effect.gen(function* () { const { stdin, ...rest } = yield* Stdio.Stdio; return [stdin, rest]; });`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const program = Effect.gen(function* () { return (yield* Stdio.Stdio).stdout(); });`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const written = Effect.flatMap(Stdio.Stdio, write);`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const provided = work.pipe(Effect.provideService(Stdio.Stdio, service));`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      {
        code: `${STDIO}export const LIVE = Layer.succeed(Stdio.Stdio, service);`,
        errors: [usedForMore("Stdio.Stdio")],
      },
      { code: `${STDIO}export const Tag = Stdio.Stdio;`, errors: [usedForMore("Stdio.Stdio")] },
      {
        code: 'import { Effect } from "effect"; import { Stdio } from "effect/Stdio"; export const program = Effect.gen(function* () { const stdio = yield* Stdio; return stdio.stderr(); });',
        errors: [usedForMore("Stdio")],
      },
    ],
  }),
);
