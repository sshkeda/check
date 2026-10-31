import { open } from "node:fs/promises";

import type { Subprocess } from "bun";
import type { Array as Arrays, Schema } from "effect";
import { Effect, FileSystem } from "effect";

import {
  ToolExited,
  ToolNotStarted,
  ToolReportUndecodable,
  ToolStoppedBySignal,
} from "./project-config-and-tool-errors.ts";

const LINE_BREAK = "\n";

const KIBIBYTES_PER_RUN_A_QUARTER_OF_THE_MACOS_ARGUMENT_MAX = 256;
const BYTES_PER_KIBIBYTE = 1024;
const ARGUMENT_BYTES_PER_RUN_A_QUARTER_OF_THE_MACOS_ARGUMENT_MAX =
  KIBIBYTES_PER_RUN_A_QUARTER_OF_THE_MACOS_ARGUMENT_MAX * BYTES_PER_KIBIBYTE;

export const linesOf = (text: string) => text.split(LINE_BREAK).filter((line) => line !== "");

const bytesOnTheCommandLine = (toolArgument: string) => Buffer.byteLength(toolArgument) + 1;

export const argumentsInRunsOfBoundedSize = (toolArguments: readonly string[]) => {
  const runs: { readonly toolArguments: string[]; bytes: number }[] = [];
  for (const toolArgument of toolArguments) {
    const bytes = bytesOnTheCommandLine(toolArgument);
    const lastRun = runs.at(-1);
    const fitsTheLastRun =
      lastRun !== undefined &&
      lastRun.bytes + bytes <= ARGUMENT_BYTES_PER_RUN_A_QUARTER_OF_THE_MACOS_ARGUMENT_MAX;
    if (fitsTheLastRun) {
      lastRun.toolArguments.push(toolArgument);
      lastRun.bytes += bytes;
    } else {
      runs.push({ toolArguments: [toolArgument], bytes });
    }
  }
  return runs.map((run) => run.toolArguments);
};

export const mergedExit = (exits: Arrays.NonEmptyReadonlyArray<ToolExited>) => {
  const [firstExit] = exits;
  const highestCode = Math.max(...exits.map(({ code }) => code));
  const exitWithTheHighestCode = exits.find(({ code }) => code === highestCode) ?? firstExit;
  return new ToolExited({
    program: firstExit.program,
    command: exitWithTheHighestCode.command,
    code: exitWithTheHighestCode.code,
    standardOutput: exits.map(({ standardOutput }) => standardOutput).join(LINE_BREAK),
    standardError: [...new Set(exits.map(({ standardError }) => standardError))]
      .filter((standardError) => standardError !== "")
      .join(LINE_BREAK),
  });
};

const WINDOWS = "win32";

const openedStandardOutputFile = (file: string) =>
  Effect.acquireRelease(
    Effect.promise(() => open(file, "w")),
    (handle) => Effect.promise(() => handle.close()),
  );

const stopTheProcessGroupOf = (child: Subprocess) =>
  Effect.gen(function* () {
    if (process.platform === WINDOWS) {
      yield* Effect.try(() =>
        Bun.spawn(["taskkill", "/pid", `${child.pid}`, "/T", "/F"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      ).pipe(
        Effect.flatMap((taskkill) => Effect.promise(() => taskkill.exited)),
        Effect.catchTag("UnknownError", () => Effect.void),
      );
      child.kill();
    } else {
      yield* Effect.try(() => process.kill(-child.pid, "SIGKILL")).pipe(
        Effect.catchTag("UnknownError", () => Effect.void),
      );
    }
    yield* Effect.promise(() => child.exited);
  });

const spawnedTool = (
  command: string,
  binary: string,
  toolArguments: readonly string[],
  standardOutput: number,
  workingDirectory?: string,
  environment?: Record<string, string>,
) =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([binary, ...toolArguments], {
          ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
          env: { ...process.env, ...environment },
          detached: process.platform !== WINDOWS,
          stdin: "ignore",
          stdout: standardOutput,
          stderr: "pipe",
        }),
      catch: (cause) =>
        new ToolNotStarted({
          command,
          reason:
            cause instanceof Error ? cause.message : "the spawn threw a value that is not an Error",
        }),
    }),
    stopTheProcessGroupOf,
  );

export const runTool = (
  program: string,
  binary: string,
  toolArguments: readonly string[],
  workingDirectory?: string,
  environment?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const standardOutputFile = yield* fileSystem.makeTempFileScoped();
      const handle = yield* openedStandardOutputFile(standardOutputFile);
      const command = [binary, ...toolArguments].join(" ");
      const child = yield* spawnedTool(
        command,
        binary,
        toolArguments,
        handle.fd,
        workingDirectory,
        environment,
      );
      const [standardError, code] = yield* Effect.all(
        [
          Effect.promise(() => new Response(child.stderr).text()),
          Effect.promise(() => child.exited),
        ],
        { concurrency: "unbounded" },
      );
      const standardOutput = yield* fileSystem.readFileString(standardOutputFile);
      if (child.signalCode !== null) {
        return yield* new ToolStoppedBySignal({ program, command, signal: `${child.signalCode}` });
      }
      if (code !== 0) {
        return yield* new ToolExited({
          program,
          command,
          code,
          standardOutput,
          standardError: standardError.trim(),
        });
      }
      return { standardOutput, standardError };
    }),
  );

export const decodedReport = <Report, Requirements>(
  program: string,
  decode: (standardOutput: string) => Effect.Effect<Report, Schema.SchemaError, Requirements>,
  standardOutput: string,
) =>
  decode(standardOutput).pipe(
    Effect.mapError(
      (error) =>
        new ToolReportUndecodable({ program, reason: error.message, report: standardOutput }),
    ),
  );
