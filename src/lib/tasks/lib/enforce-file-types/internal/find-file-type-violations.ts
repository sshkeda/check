import { Effect, Option } from "effect";

import { fileNameOf } from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import {
  FILE_TYPE,
  GENERATED,
} from "../../../../../shared/record-and-grant-permissions-by-path.ts";
import type { PERMISSION_NAMES } from "../../../../../shared/record-and-grant-permissions-by-path.ts";
import { inEachPackage } from "../../../shared/check-each-nested-package.ts";
import { listedPackageFiles } from "../../../shared/list-package-files.ts";
import { loadedLintConfigIn } from "../../../shared/load-the-lint-config.ts";
import {
  isGrantedPatchFile,
  listedPatchesOf,
  rootManifestIn,
} from "../../../shared/match-granted-patch-files.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { toolFileOf } from "../../../shared/tool-file-locations.ts";
import { FileTypeNotGranted, FileTypeViolations } from "./file-type-errors.ts";

const FILE_TYPES = "file-types";
const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".md"] as const;

export const fileTypeViolations = (
  paths: readonly string[],
  grants: readonly {
    readonly path: string;
    readonly allow?: readonly (typeof PERMISSION_NAMES)[number][];
  }[],
  listedPatchPaths: ReadonlySet<string> = new Set(),
) =>
  paths
    .filter((path) => {
      const allowedByDefault =
        DEFAULT_EXTENSIONS.some((extension) => path.endsWith(extension)) ||
        toolFileOf(path)?.allowsFileType === true;
      const granted = grants.some(
        (grant) =>
          grant.path === path &&
          grant.allow?.some(
            (permission) => permission === FILE_TYPE || permission === GENERATED,
          ) === true,
      );
      const isListedGrantedPatch = listedPatchPaths.has(path) && isGrantedPatchFile(path, grants);
      return !allowedByDefault && !granted && !isListedGrantedPatch;
    })
    .map(
      (path) =>
        new FileTypeNotGranted({
          location: path,
          fileType: /\.[^.]+$/u.exec(fileNameOf(path))?.[0] ?? fileNameOf(path),
        }),
    );

export const findFileTypeViolations = (directory: string) =>
  Effect.gen(function* () {
    const { packageFiles } = yield* listedPackageFiles(directory, []);
    const grants = yield* loadedLintConfigIn(directory).pipe(
      Effect.asSome,
      Effect.catchTag("LintConfigRefused", () => Effect.succeedNone),
    );
    if (Option.isNone(grants)) {
      return;
    }
    const listedPatchPaths = new Set(
      listedPatchesOf(yield* rootManifestIn(directory, packageFiles)).map(
        ({ patchPath }) => patchPath,
      ),
    );
    const violations = fileTypeViolations(packageFiles, grants.value, listedPatchPaths);
    if (violations.length > 0) {
      return yield* new FileTypeViolations({ violations });
    }
  });

export const fileTypeViolationsOfEachPackage = inEachPackage(FILE_TYPES, (packageDirectory) =>
  findFileTypeViolations(packageDirectory).pipe(quietViolations(FILE_TYPES)),
);
