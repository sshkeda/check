import { Array as Arrays, Effect, FileSystem, Path } from "effect";

import { FORMAT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import { printableError } from "../../../../../shared/format-reported-failures.ts";
import { enclosingDirectoriesOf } from "../../../shared/classify-files-by-role.ts";
import { encodeJson } from "../../../shared/encode-compact-json.ts";
import { isSymbolicLink } from "../../../shared/find-symbolic-links.ts";
import {
  failQuietly,
  quietViolations,
} from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import {
  argumentsInRunsOfBoundedSize,
  mergedExit,
  runTool,
} from "../../../shared/run-tools-and-decode-their-reports.ts";
import { UnformattedFile } from "./unformatted-file-errors.ts";

const BUN_FORMAT = "bun fmt";

const BUN_FORMAT_TASK = "bun-fmt";

const LISTED_FILE_SEPARATOR = "\n";

const BUN_FORMAT_ARGUMENTS = [
  "fmt",
  `--config=${FORMAT_CONFIG_FILE}`,
  "--disable-nested-config",
  "--list-different",
] as const;

const CONTROL_CHARACTER = /\p{Cc}/u;

const filesBunFormatFormatsAmong = (checkedProject: string, files: readonly string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const onDisk = (file: string) => path.join(checkedProject, file);
    const listed = files.filter((file) => file !== FORMAT_CONFIG_FILE);
    const linkedDirectories = new Set(
      yield* Effect.filter(
        new Set(listed.flatMap((file) => enclosingDirectoriesOf(file))),
        (directory) => isSymbolicLink(onDisk(directory)),
        { concurrency: "unbounded" },
      ),
    );
    const withNoLinkedDirectoryAbove = listed.filter(
      (file) => !enclosingDirectoriesOf(file).some((directory) => linkedDirectories.has(directory)),
    );
    const isRegularFile = yield* Effect.forEach(
      withNoLinkedDirectoryAbove,
      (file) =>
        Effect.gen(function* () {
          if (linkedDirectories.has(file)) {
            return false;
          }
          if (yield* isSymbolicLink(onDisk(file))) {
            return false;
          }
          return (yield* fileSystem.stat(onDisk(file))).type === "File";
        }),
      { concurrency: "unbounded" },
    );
    return withNoLinkedDirectoryAbove.filter((_file, index) => isRegularFile[index] === true);
  });

const isPrintedOnOneLine = (file: string) => !file.includes(LISTED_FILE_SEPARATOR);

const outputBeforeItsEndingNewline = (standardOutput: string) =>
  standardOutput.endsWith(LISTED_FILE_SEPARATOR)
    ? standardOutput.slice(0, -LISTED_FILE_SEPARATOR.length)
    : standardOutput;

const listedLinesOf = (standardOutput: string) => {
  const output = outputBeforeItsEndingNewline(standardOutput);
  return output === "" ? [] : output.split(LISTED_FILE_SEPARATOR);
};

const filesListedInARunOfOneFileNotPrintedOnOneLine = (file: string, standardOutput: string) =>
  [FORMAT_CONFIG_FILE, file].filter((listed) =>
    listed === file
      ? standardOutput.includes(file)
      : listedLinesOf(standardOutput).includes(FORMAT_CONFIG_FILE),
  );

const formatArgumentOf = (file: string) => `./${file}`;

const ranBunFormat = (checkedProject: string, fileArguments: readonly string[]) =>
  runTool(
    BUN_FORMAT,
    process.execPath,
    [...BUN_FORMAT_ARGUMENTS, formatArgumentOf(FORMAT_CONFIG_FILE), ...fileArguments],
    checkedProject,
  ).pipe(
    Effect.map(({ standardOutput }) => ({ exited: undefined, standardOutput })),
    Effect.catchTag("ToolExited", (exited) =>
      Effect.succeed({ exited, standardOutput: exited.standardOutput }),
    ),
  );

const unformattedFileOf = (file: string) =>
  Effect.gen(function* () {
    const location = CONTROL_CHARACTER.test(file) ? yield* encodeJson(file) : file;
    return printableError(new UnformattedFile({ file: location }));
  });

const bunFormatReportOn = (checkedProject: string, packageFiles: readonly string[]) =>
  Effect.gen(function* () {
    const formatted = yield* filesBunFormatFormatsAmong(checkedProject, packageFiles);
    const runs = [
      ...argumentsInRunsOfBoundedSize(
        formatted.filter((file) => isPrintedOnOneLine(file)).map((file) => formatArgumentOf(file)),
      ).map((fileArguments) => ({
        fileArguments,
        listedIn: listedLinesOf,
      })),
      ...formatted
        .filter((file) => !isPrintedOnOneLine(file))
        .map((file) => ({
          fileArguments: [formatArgumentOf(file)],
          listedIn: (standardOutput: string) =>
            filesListedInARunOfOneFileNotPrintedOnOneLine(file, standardOutput),
        })),
    ];
    if (runs.length === 0) {
      runs.push({ fileArguments: [], listedIn: listedLinesOf });
    }
    const ran = yield* Effect.forEach(runs, (run) =>
      ranBunFormat(checkedProject, run.fileArguments).pipe(
        Effect.map(({ exited, standardOutput }) => ({
          exited,
          listed: run.listedIn(standardOutput),
        })),
      ),
    );
    const exits = ran.flatMap(({ exited }) => (exited === undefined ? [] : [exited]));
    return {
      unformatted: [...new Set(ran.flatMap(({ listed }) => listed))].toSorted(),
      exited: Arrays.isReadonlyArrayNonEmpty(exits) ? mergedExit(exits) : undefined,
    };
  });

export const unformattedFilesAmong = (checkedProject: string, packageFiles: readonly string[]) =>
  Effect.gen(function* () {
    const report = yield* bunFormatReportOn(checkedProject, packageFiles).pipe(
      quietViolations(BUN_FORMAT_TASK),
    );
    if (report.exited !== undefined) {
      return yield* failQuietly(
        BUN_FORMAT_TASK,
        report.exited,
        Arrays.append(
          yield* Effect.forEach(report.unformatted, unformattedFileOf),
          printableError(report.exited),
        ),
      );
    }
  });
