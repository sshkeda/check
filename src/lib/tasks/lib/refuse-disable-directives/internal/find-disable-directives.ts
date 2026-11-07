import { Array as Arrays, Effect, FileSystem, Path, Result } from "effect";
import { parseSync } from "oxc-parser";

import { FORMAT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import { isDirective } from "../../../../../shared/lint-rule-messages-and-patterns.ts";
import { lineNumbersIn, lineOfTheFirstLabel } from "../../../shared/count-the-line-of-an-offset.ts";
import { lintedFiles } from "../../../shared/list-linted-files.ts";
import { isFormatConfigTextRefusedIn } from "../../../shared/parse-config-files-that-import-from-check.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { SourceFileUnparsable } from "../../../shared/project-config-and-tool-errors.ts";
import { TYPESCRIPT_PROJECT_FILE } from "../../../shared/query-the-typescript-project.ts";
import {
  DirectiveScanViolations,
  DisableDirective,
  SourceFileUnreadable,
} from "./disable-directive-errors.ts";

export const disableDirectivesIn = (file: string, directory = ".") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem
      .readFileString(path.isAbsolute(file) ? file : path.join(directory, file))
      .pipe(Effect.mapError((error) => new SourceFileUnreadable({ file, reason: error.message })));
    const parsed = parseSync(file, text);
    if (parsed.errors.length > 0) {
      return parsed.errors.map(
        (error) =>
          new SourceFileUnparsable({
            file,
            ...lineOfTheFirstLabel(text, error.labels),
            reason: error.message,
          }),
      );
    }
    const lineAt = lineNumbersIn(text);
    return parsed.comments
      .filter((comment) => isDirective(comment.value))
      .map(
        (comment) =>
          new DisableDirective({
            file,
            line: lineAt(comment.start),
            directive: comment.value.trim(),
          }),
      );
  });

export const findDisableDirectivesInLintedFilesOf = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const isFormatConfigRefused = yield* isFormatConfigTextRefusedIn(directory);
    const files = (yield* lintedFiles(path.join(directory, TYPESCRIPT_PROJECT_FILE))).filter(
      (file) => !isFormatConfigRefused || file !== FORMAT_CONFIG_FILE,
    );
    const scans = yield* Effect.forEach(
      files,
      (file) =>
        disableDirectivesIn(file, directory).pipe(
          Effect.map(Result.succeed),
          Effect.catchTag("SourceFileUnreadable", (unscanned) =>
            Effect.succeed(Result.fail(unscanned)),
          ),
        ),
      { concurrency: "unbounded" },
    );
    const [directivesByFile, unscannedFiles] = Arrays.separate(scans);
    const violations = [...unscannedFiles, ...Arrays.flatten(directivesByFile)];
    if (violations.length > 0) {
      return yield* new DirectiveScanViolations({ violations });
    }
  }).pipe(quietViolations("directives"));
