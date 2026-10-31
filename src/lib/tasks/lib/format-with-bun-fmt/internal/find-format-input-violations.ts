import { Effect, FileSystem, Path, Predicate, Result } from "effect";

import { FORMAT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import { fileNameOf } from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import {
  CompetingFormatterConfig,
  FormatInputsRefused,
  PackagePrettierField,
} from "../../../shared/project-config-and-tool-errors.ts";
import { packageManifestObject } from "../../../shared/read-package-manifest-object.ts";

const PRETTIER_IGNORE_FILE = ".prettierignore";

const COMPETING_FORMATTER_CONFIG_NAMES = [
  ".oxfmtrc*",
  "oxfmt.config.*",
  ".prettierrc*",
  "prettier.config.*",
  PRETTIER_IGNORE_FILE,
];

const COMPETING_FORMATTER_CONFIG_GLOBS = COMPETING_FORMATTER_CONFIG_NAMES.map(
  (nameGlob) => new Bun.Glob(nameGlob),
);

const isCompetingFormatterConfig = (file: string) =>
  file !== FORMAT_CONFIG_FILE &&
  COMPETING_FORMATTER_CONFIG_GLOBS.some((nameGlob) => nameGlob.match(fileNameOf(file)));

const prettierFieldViolationsIn = (directory: string, manifests: readonly string[]) =>
  Effect.forEach(manifests, (manifest) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parsed = packageManifestObject(
        manifest,
        yield* fileSystem.readFileString(path.join(directory, manifest)),
      );
      if (Result.isFailure(parsed)) {
        return [parsed.failure];
      }
      return Predicate.hasProperty(parsed.success, "prettier")
        ? [new PackagePrettierField({ location: manifest })]
        : [];
    }),
  ).pipe(Effect.map((violations) => violations.flat()));

export const checkedFormatInputsIn = (directory: string, packageFiles: readonly string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const competingConfigs = new Set([
      ...packageFiles.filter((file) => isCompetingFormatterConfig(file)),
      ...(yield* fileSystem.glob(`{${COMPETING_FORMATTER_CONFIG_NAMES.join(",")}}`, {
        root: directory,
      })).filter((file) => file !== FORMAT_CONFIG_FILE),
      ...((yield* fileSystem.exists(path.join(directory, PRETTIER_IGNORE_FILE)))
        ? [PRETTIER_IGNORE_FILE]
        : []),
    ]);
    const violations = [
      ...[...competingConfigs]
        .toSorted()
        .map((location) => new CompetingFormatterConfig({ location })),
      ...(yield* prettierFieldViolationsIn(
        directory,
        packageFiles.filter((file) => fileNameOf(file) === PACKAGE_MANIFEST_FILE),
      )),
    ];
    if (violations.length > 0) {
      return yield* new FormatInputsRefused({ violations });
    }
  });
