import { Effect, Record } from "effect";

import {
  BUILD_OUTPUT_OPTIONS,
  BuildOutputCompilerOption,
  LooseCompilerOption,
  OPTIONS_TSC_LEAVES_UNSET,
  REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
  STRICT_OPTIONS,
  TypeScriptConfigViolations,
} from "./project-config-and-tool-errors.ts";
import {
  compilesFiles,
  effectiveCompilerOptions,
  projectConfigFiles,
} from "./query-the-typescript-project.ts";

const optionViolationsOf = (configFile: string, isReferenced: boolean) =>
  effectiveCompilerOptions(configFile).pipe(
    Effect.map((options) => {
      const emitOption = isReferenced ? "emitDeclarationOnly" : "noEmit";
      const looseOptions = [
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
              (options[option] ?? (OPTIONS_TSC_LEAVES_UNSET.has(option) ? undefined : false)),
          }),
        ),
        { option: emitOption, required: true, resolvedValue: options[emitOption] } as const,
      ].flatMap(({ option, required, resolvedValue }) => {
        if (resolvedValue === undefined) {
          return [new LooseCompilerOption({ projectFile: configFile, option })];
        }
        const isLoose = typeof resolvedValue === "boolean" && resolvedValue !== required;
        return isLoose
          ? [new LooseCompilerOption({ projectFile: configFile, option, resolvedValue })]
          : [];
      });
      const buildOutputOptions = (isReferenced ? [] : BUILD_OUTPUT_OPTIONS)
        .filter((option) => options[option] !== undefined && options[option] !== false)
        .map((option) => new BuildOutputCompilerOption({ projectFile: configFile, option }));
      return [...looseOptions, ...buildOutputOptions];
    }),
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
        AbsoluteProjectReference: (absolute) =>
          Effect.fail(new TypeScriptConfigViolations({ violations: [absolute] })),
      }),
    );
    const [rootConfigFile] = builtConfigFiles;
    const compilingConfigFiles = yield* Effect.filter(builtConfigFiles, compilesFiles);
    const violations = (yield* Effect.forEach(compilingConfigFiles, (configFile) =>
      optionViolationsOf(configFile, configFile !== rootConfigFile),
    )).flat();
    if (violations.length > 0) {
      return yield* new TypeScriptConfigViolations({ violations });
    }
  });
