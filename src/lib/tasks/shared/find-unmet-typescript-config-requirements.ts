import { Effect, Record } from "effect";

import {
  LooseCompilerOption,
  REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
  STRICT_OPTIONS,
  TypeScriptConfigViolations,
} from "./project-config-and-tool-errors.ts";
import {
  compilesFiles,
  effectiveCompilerOptions,
  projectConfigFiles,
} from "./query-the-typescript-project.ts";

const optionViolationsOf = (configFile: string) =>
  effectiveCompilerOptions(configFile).pipe(
    Effect.map((options) =>
      [
        ...STRICT_OPTIONS.map((option) => ({
          option,
          required: true,
          resolvedValue: options[option] ?? true,
        })),
        ...Record.toEntries(REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT).map(
          ([option, required]) => ({
            option,
            required,
            resolvedValue:
              (option === "allowImportingTsExtensions" &&
                options["rewriteRelativeImportExtensions"] === true) ||
              (options[option] ?? false),
          }),
        ),
      ].flatMap(({ option, required, resolvedValue }) => {
        const isLoose = typeof resolvedValue === "boolean" && resolvedValue !== required;
        return isLoose
          ? [new LooseCompilerOption({ projectFile: configFile, option, resolvedValue })]
          : [];
      }),
    ),
  );

export const findTypeScriptConfigViolations = (projectFile: string) =>
  Effect.gen(function* () {
    const builtConfigFiles = yield* projectConfigFiles(projectFile).pipe(
      Effect.catchTags({
        TypeScriptProjectFileMissing: (missing) =>
          Effect.fail(new TypeScriptConfigViolations({ violations: [missing] })),
        TypeScriptConfigUnparsable: (unparsable) =>
          Effect.fail(new TypeScriptConfigViolations({ violations: [unparsable] })),
        ProjectReferencesUndecodable: (undecodable) =>
          Effect.fail(new TypeScriptConfigViolations({ violations: [undecodable] })),
      }),
    );
    const compilingConfigFiles = yield* Effect.filter(builtConfigFiles, compilesFiles);
    const violations = (yield* Effect.forEach(compilingConfigFiles, optionViolationsOf)).flat();
    if (violations.length > 0) {
      return yield* new TypeScriptConfigViolations({ violations });
    }
  });
