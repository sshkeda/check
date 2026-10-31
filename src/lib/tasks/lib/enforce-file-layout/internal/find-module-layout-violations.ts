import {
  fileNameOf,
  isEntryFileName,
  LAYOUT_DIRECTORY_NAMES,
  LIBRARY_DIRECTORY_NAME,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import { SOURCE_DIRECTORY, TEST_DIRECTORY } from "../../../../../shared/test-home-directories.ts";
import { directoryOf, enclosingDirectoriesOf } from "../../../shared/classify-files-by-role.ts";
import {
  DirectoryOutsideModuleLayout,
  FileInLibraryDirectory,
  ModuleWithLayoutDirectoryName,
  ModuleWithoutIndex,
} from "./file-layout-errors.ts";

export const isModuleDirectory = (directory: string): boolean => {
  const parent = directoryOf(directory);
  return (
    directory === SOURCE_DIRECTORY ||
    directory === TEST_DIRECTORY ||
    (fileNameOf(parent) === LIBRARY_DIRECTORY_NAME && isModuleDirectory(directoryOf(parent)))
  );
};

export const isLibraryDirectoryOfAModule = (directory: string) =>
  fileNameOf(directory) === LIBRARY_DIRECTORY_NAME && isModuleDirectory(directoryOf(directory));

const MODULE_SUBDIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ...LAYOUT_DIRECTORY_NAMES,
  LIBRARY_DIRECTORY_NAME,
]);

const isOutsideModuleLayout = (directory: string) =>
  isModuleDirectory(directoryOf(directory)) &&
  !MODULE_SUBDIRECTORY_NAMES.has(fileNameOf(directory));

export const directoriesOutsideModuleLayoutAmong = (paths: readonly string[]) => [
  ...new Set(
    paths
      .flatMap((path) => enclosingDirectoriesOf(path))
      .filter((directory) => isOutsideModuleLayout(directory)),
  ),
];

export const moduleLayoutViolations = (paths: readonly string[]) => {
  const directories = [...new Set(paths.flatMap((path) => enclosingDirectoriesOf(path)))];
  const indexedDirectories = new Set(
    paths.filter((path) => isEntryFileName(fileNameOf(path))).map((path) => directoryOf(path)),
  );
  return [
    ...directoriesOutsideModuleLayoutAmong(paths).map(
      (directory) =>
        new DirectoryOutsideModuleLayout({ location: directory, module: directoryOf(directory) }),
    ),
    ...directories
      .filter(
        (directory) =>
          isLibraryDirectoryOfAModule(directoryOf(directory)) && !indexedDirectories.has(directory),
      )
      .map((directory) => new ModuleWithoutIndex({ location: directory })),
    ...paths
      .filter((path) => isLibraryDirectoryOfAModule(directoryOf(path)))
      .map((path) => new FileInLibraryDirectory({ location: path })),
  ];
};

export const modulesWithLayoutDirectoryNamesAmong = (paths: readonly string[]) => [
  ...new Set(
    paths
      .flatMap((path) => enclosingDirectoriesOf(path))
      .filter(
        (directory) =>
          isLibraryDirectoryOfAModule(directoryOf(directory)) &&
          MODULE_SUBDIRECTORY_NAMES.has(fileNameOf(directory)),
      ),
  ),
];

export const moduleWithLayoutDirectoryNameViolations = (paths: readonly string[]) =>
  modulesWithLayoutDirectoryNamesAmong(paths).map(
    (directory) => new ModuleWithLayoutDirectoryName({ location: directory }),
  );
