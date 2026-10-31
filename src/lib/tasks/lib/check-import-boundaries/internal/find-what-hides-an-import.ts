import { Array as Arrays, Option } from "effect";

import {
  fileNameOf,
  INTERNAL_DIRECTORY_NAME,
  isEntryFileName,
  isWithin,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import { directoryOf, enclosingDirectoriesOf } from "../../../shared/classify-files-by-role.ts";

export const whatHidesTheImport = (
  importerPath: string,
  importedPath: string,
  moduleDirectories: ReadonlySet<string>,
  otherPackageDirectory: string | undefined,
) =>
  Option.getOrUndefined(
    Arrays.findFirst(
      enclosingDirectoriesOf(importedPath),
      (
        directory,
      ): Option.Option<
        | {
            readonly hiddenBy: "plain directory";
            readonly directory: string;
            readonly parent: string;
          }
        | { readonly hiddenBy: "internal"; readonly directory: string; readonly parent: string }
        | { readonly hiddenBy: "module"; readonly directory: string }
        | { readonly hiddenBy: "package"; readonly directory: string }
      > => {
        if (isWithin(importerPath, directory)) {
          return Option.none();
        }
        const isModuleOrPackageDirectory =
          moduleDirectories.has(directory) || directory === otherPackageDirectory;
        if (isModuleOrPackageDirectory) {
          const importsDirectoryEntryFile =
            directoryOf(importedPath) === directory && isEntryFileName(fileNameOf(importedPath));
          if (importsDirectoryEntryFile) {
            return Option.none();
          }
          return Option.some(
            moduleDirectories.has(directory)
              ? ({ hiddenBy: "module", directory } as const)
              : ({ hiddenBy: "package", directory } as const),
          );
        }
        const parent = directoryOf(directory);
        const isImporterTheModuleIndex =
          directoryOf(importerPath) === parent && isEntryFileName(fileNameOf(importerPath));
        const isImporterOutsidePrivateCode =
          fileNameOf(directory) === INTERNAL_DIRECTORY_NAME &&
          moduleDirectories.has(parent) &&
          !isImporterTheModuleIndex;
        if (isImporterOutsidePrivateCode) {
          return Option.some({ hiddenBy: "internal", directory, parent } as const);
        }
        const isImporterOutsideParent = parent !== "" && !isWithin(importerPath, parent);
        return isImporterOutsideParent
          ? Option.some({ hiddenBy: "plain directory", directory, parent } as const)
          : Option.none();
      },
    ),
  );
