import { Array as Arrays, Effect, FileSystem, Path, Result } from "effect";
import { parseSync } from "oxc-parser";
import type { Comment } from "oxc-parser";

import { FORMAT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import {
  isDirective,
  isTypeScriptSuppression,
  TYPESCRIPT_NO_CHECK,
} from "../../../../../shared/lint-rule-messages-and-patterns.ts";
import { isDeclarationFile } from "../../../shared/classify-files-by-role.ts";
import { lineNumbersIn, lineOfTheFirstLabel } from "../../../shared/count-the-line-of-an-offset.ts";
import { scriptFiles } from "../../../shared/list-linted-files.ts";
import { ownedFilesAmong } from "../../../shared/list-owned-files.ts";
import { isFormatConfigTextRefusedIn } from "../../../shared/parse-config-files-that-import-from-check.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { SourceFileUnparsable } from "../../../shared/project-config-and-tool-errors.ts";
import { TYPESCRIPT_PROJECT_FILE } from "../../../shared/query-the-typescript-project.ts";
import {
  DirectiveScanViolations,
  DisableDirective,
  SourceFileUnreadable,
} from "./disable-directive-errors.ts";

const LEADING_SLASHES = /^\/+/u;

const LINE_COMMENT = "Line";

const sourceTextOf = (file: string, directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem
      .readFileString(path.isAbsolute(file) ? file : path.join(directory, file))
      .pipe(Effect.mapError((error) => new SourceFileUnreadable({ file, reason: error.message })));
  });

const directivesAmong = (file: string, text: string, comments: readonly Comment[]) => {
  const lineAt = lineNumbersIn(text);
  return comments.map(
    (comment) =>
      new DisableDirective({
        file,
        line: lineAt(comment.start),
        directive: comment.value.replace(LEADING_SLASHES, "").trim(),
      }),
  );
};

export const disableDirectivesIn = (file: string, directory = ".") =>
  Effect.gen(function* () {
    const text = yield* sourceTextOf(file, directory);
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
    return directivesAmong(
      file,
      text,
      parsed.comments.filter((comment) => isDirective(comment.value)),
    );
  });

const typeScriptDirectivesIn = (file: string, directory: string) =>
  Effect.gen(function* () {
    const text = yield* sourceTextOf(file, directory);
    const parsed = parseSync(file, text);
    if (parsed.errors.length > 0) {
      return [];
    }
    const firstStatementStart = parsed.program.body[0]?.start ?? text.length;
    return directivesAmong(
      file,
      text,
      parsed.comments.filter((comment) => {
        const isLeadingLineComment =
          comment.type === LINE_COMMENT && comment.end <= firstStatementStart;
        const isNoCheck = isLeadingLineComment && TYPESCRIPT_NO_CHECK.test(comment.value);
        return isNoCheck || isTypeScriptSuppression(comment.value);
      }),
    );
  });

export const findDisableDirectivesInLintedFilesOf = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const isFormatConfigRefused = yield* isFormatConfigTextRefusedIn(directory);
    const scripts = yield* scriptFiles(path.join(directory, TYPESCRIPT_PROJECT_FILE));
    const owned = yield* ownedFilesAmong(directory, scripts);
    const ownedFiles = new Set(owned);
    const files = owned.filter((file) => !isFormatConfigRefused || file !== FORMAT_CONFIG_FILE);
    const generatedSources = scripts.filter(
      (file) => !ownedFiles.has(file) && !isDeclarationFile(file),
    );
    const scans = yield* Effect.forEach(
      [
        ...files.map((file) => disableDirectivesIn(file, directory)),
        ...generatedSources.map((file) => typeScriptDirectivesIn(file, directory)),
      ],
      (scan) =>
        scan.pipe(
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
