import { Array as Arrays, Effect, FileSystem, Path, Schema, Stream } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess } from "effect/process";

import { printableError } from "../../../../../shared/format-reported-failures.ts";
import { encodeJson } from "../../../shared/encode-compact-json.ts";
import {
  failQuietly,
  quietToolFailure,
  quietViolations,
} from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import {
  ToolExited,
  ToolReportedViolations,
  ToolStoppedBySignal,
} from "../../../shared/project-config-and-tool-errors.ts";
import { tsgolintExecutable } from "./find-tsgolint-executable.ts";
import { EnumLintFailed, tsgolintRuleMessages } from "./read-tsgolint-rule-messages.ts";

const TSGOLINT = "tsgolint";
const HEADLESS_ARGUMENTS = ["headless"] as const;
const RULE_NAME = "no-unsafe-enum-assignment";
const PAYLOAD_VERSION = 2;
const STOPPING_SIGNAL = /signal:? '?(?<signal>SIG[A-Z0-9]+)/u;

const failureNamingTheSignal = (command: string, failure: PlatformError.PlatformError) => {
  const described = `${failure.message}\n${String(failure.cause)}`;
  const signal = STOPPING_SIGNAL.exec(described)?.groups?.["signal"];
  return signal === undefined
    ? failure
    : new ToolStoppedBySignal({ program: TSGOLINT, command, signal });
};

const decodedRuleMessages = (output: Buffer) =>
  Effect.try({
    try: () => tsgolintRuleMessages(output),
    catch: (cause) =>
      Schema.is(EnumLintFailed)(cause) ? cause : new EnumLintFailed({ reason: String(cause) }),
  });

const errorsTsgolintReportedOnExit = (output: Buffer) =>
  decodedRuleMessages(output).pipe(
    Effect.as({ violations: [], notes: [] }),
    Effect.catchTag("EnumLintFailed", (failed) =>
      Effect.succeed({ violations: [printableError(failed)], notes: [] }),
    ),
  );

const unsafeEnumViolationsIn = (
  directory: string,
  reports: ReturnType<typeof tsgolintRuleMessages>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.forEach(
      reports.filter((report) => report.rule === RULE_NAME && report.file_path !== null),
      (report) =>
        Effect.gen(function* () {
          const filename = report.file_path ?? "";
          const source = yield* fileSystem.readFile(filename);
          const preceding = Buffer.from(source)
            .subarray(0, report.range?.pos ?? 0)
            .toString("utf8");
          const lines = preceding.split("\n");
          const column = (lines.at(-1)?.length ?? 0) + 1;
          return {
            tag: `typescript(${RULE_NAME})`,
            location: `${path.relative(directory, filename)}:${lines.length}:${column}`,
            message: report.message.description,
          };
        }),
    );
  });

const ranTsgolint = (binary: string, directory: string, files: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const command = [binary, ...HEADLESS_ARGUMENTS].join(" ");
      const input = yield* encodeJson({
        version: PAYLOAD_VERSION,
        configs: [
          {
            file_paths: files.map((file) => path.resolve(directory, file)),
            rules: [{ name: RULE_NAME }],
          },
        ],
      });
      const child = yield* ChildProcess.make(binary, HEADLESS_ARGUMENTS, {
        extendEnv: true,
        stdin: Stream.make(Buffer.from(input)),
        stderr: "pipe",
      });
      const [chunks, standardError, code] = yield* Effect.all(
        [
          Stream.runCollect(child.stdout),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode.pipe(
            Effect.mapError((failure) => failureNamingTheSignal(command, failure)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { command, code, output: Buffer.concat(chunks), standardError: standardError.trim() };
    }),
  );

export const checkUnsafeEnumAssignmentsWith = (
  binary: string,
  directory: string,
  files: readonly string[],
) =>
  Effect.gen(function* () {
    const { command, code, output, standardError } = yield* ranTsgolint(
      binary,
      directory,
      files,
    ).pipe(quietViolations(TSGOLINT));
    if (code !== 0) {
      return yield* Effect.fail(
        new ToolExited({
          program: TSGOLINT,
          command,
          code,
          standardOutput: output.toString("utf8"),
          standardError,
        }),
      ).pipe(quietToolFailure(TSGOLINT, () => errorsTsgolintReportedOnExit(output)));
    }
    const violations = yield* Effect.flatMap(decodedRuleMessages(output), (reports) =>
      unsafeEnumViolationsIn(directory, reports),
    ).pipe(quietViolations(TSGOLINT));
    if (Arrays.isReadonlyArrayNonEmpty(violations)) {
      const reported = new ToolReportedViolations({
        program: TSGOLINT,
        command,
        code,
        count: violations.length,
      });
      return yield* failQuietly(
        TSGOLINT,
        reported,
        Arrays.append(violations, printableError(reported)),
      );
    }
  });

export const checkUnsafeEnumAssignmentsIn = (directory: string, files: readonly string[]) =>
  Effect.flatMap(tsgolintExecutable.pipe(quietViolations(TSGOLINT)), (binary) =>
    checkUnsafeEnumAssignmentsWith(binary, directory, files),
  );
