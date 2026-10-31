import { Effect, FileSystem, Path, Schema } from "effect";
import { ScriptKind } from "typescript/unstable/ast";

import { inEachPackage } from "../../../shared/check-each-nested-package.ts";
import { isDeclarationFile } from "../../../shared/classify-files-by-role.ts";
import { scriptFiles } from "../../../shared/list-linted-files.ts";
import { ownedFilesAmong } from "../../../shared/list-owned-files.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import {
  effectiveCompilerOptions,
  packageSourceFilesOfEachProject,
  TYPESCRIPT_PROJECT_FILE,
} from "../../../shared/query-the-typescript-project.ts";
import {
  LintedDeclarationFileNotTypeChecked,
  LintedFileOutsideTypeScriptProgram,
  LintedFilesNotTypeChecked,
  LintedJavaScriptFileNotTypeChecked,
} from "./linted-file-errors.ts";

const OPTIONS_THAT_SKIP_FILES = Schema.Struct({
  checkJs: Schema.optionalKey(Schema.Boolean),
  skipLibCheck: Schema.optionalKey(Schema.Boolean),
});

const JAVASCRIPT_SCRIPT_KINDS = new Set([ScriptKind.JS, ScriptKind.JSX]);

const isTypeChecked = (
  sourceFile: { readonly isDeclarationFile: boolean; readonly scriptKind: ScriptKind },
  options: typeof OPTIONS_THAT_SKIP_FILES.Type,
) =>
  sourceFile.isDeclarationFile
    ? options.skipLibCheck !== true
    : !JAVASCRIPT_SCRIPT_KINDS.has(sourceFile.scriptKind) || options.checkJs === true;

const realPathOf = (file: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.realPath(file));

const violationFor = (
  file: string,
  projectFile: string,
  compilingProjects: readonly {
    readonly configFile: string;
    readonly isDeclarationFile: boolean;
  }[],
) => {
  const [firstProject] = compilingProjects;
  if (firstProject === undefined) {
    return new LintedFileOutsideTypeScriptProgram({ location: file, projectFile });
  }
  const configFiles = compilingProjects.map(({ configFile }) => configFile);
  return firstProject.isDeclarationFile
    ? new LintedDeclarationFileNotTypeChecked({ location: file, configFiles })
    : new LintedJavaScriptFileNotTypeChecked({ location: file, configFiles });
};

export const findLintedFilesNotTypeChecked = (projectFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const linted = yield* scriptFiles(projectFile);
    const owned = new Set(yield* ownedFilesAmong(path.dirname(projectFile), linted));
    const compilations = (yield* Effect.forEach(
      yield* packageSourceFilesOfEachProject(projectFile),
      ({ configFile, sourceFiles }) =>
        Effect.gen(function* () {
          const options = yield* effectiveCompilerOptions(configFile).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(OPTIONS_THAT_SKIP_FILES)),
          );
          return yield* Effect.forEach(
            sourceFiles,
            ([file, sourceFile]) =>
              realPathOf(path.join(path.dirname(projectFile), file)).pipe(
                Effect.map((realFile) => ({
                  realFile,
                  configFile,
                  isDeclarationFile: sourceFile.isDeclarationFile,
                  typeChecked: isTypeChecked(sourceFile, options),
                })),
              ),
            { concurrency: "unbounded" },
          );
        }),
    )).flat();
    const lintedRealFiles = yield* Effect.forEach(
      linted,
      (file) =>
        realPathOf(path.join(path.dirname(projectFile), file)).pipe(
          Effect.map((realFile) => ({ file, realFile })),
        ),
      { concurrency: "unbounded" },
    );
    const violations = lintedRealFiles.flatMap(({ file, realFile }) => {
      const compiling = compilations.filter((compilation) => compilation.realFile === realFile);
      const isGeneratedDeclarationFile =
        !owned.has(file) &&
        (isDeclarationFile(file) || compiling.some((compilation) => compilation.isDeclarationFile));
      const isTypeCheckedOrExempt =
        isGeneratedDeclarationFile || compiling.some(({ typeChecked }) => typeChecked);
      return isTypeCheckedOrExempt ? [] : [violationFor(file, projectFile, compiling)];
    });
    if (violations.length > 0) {
      return yield* new LintedFilesNotTypeChecked({ violations });
    }
  });

const LINTED_FILES_TYPE_CHECKED = "linted-files-type-checked";

export const lintedFilesNotTypeCheckedInEachPackage = inEachPackage(
  LINTED_FILES_TYPE_CHECKED,
  ".",
  (packageDirectory) =>
    Path.Path.use((path) =>
      findLintedFilesNotTypeChecked(path.join(packageDirectory, TYPESCRIPT_PROJECT_FILE)).pipe(
        quietViolations(LINTED_FILES_TYPE_CHECKED),
      ),
    ),
);
