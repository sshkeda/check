import type { Array as Arrays, Schema } from "effect";
import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";

import { ToolExited, ToolReportUndecodable } from "./project-config-and-tool-errors.ts";

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

export const runTool = (
  program: string,
  binary: string,
  toolArguments: readonly string[],
  workingDirectory?: string,
  environment?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(binary, toolArguments, {
        ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
        extendEnv: true,
        env: environment,
        stdin: "ignore",
        stderr: "pipe",
      });
      const [standardOutput, standardError, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0) {
        return yield* new ToolExited({
          program,
          command: [binary, ...toolArguments].join(" "),
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
