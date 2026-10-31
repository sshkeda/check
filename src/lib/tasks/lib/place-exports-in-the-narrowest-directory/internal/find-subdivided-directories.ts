import { TEST_DIRECTORY } from "../../../../../shared/test-home-directories.ts";
import {
  directoryOf,
  enclosingDirectoriesOf,
  isScript,
  isSpecialContainer,
} from "../../../shared/classify-files-by-role.ts";

const isTestDirectoryPath = (directory: string) =>
  directory.split("/").some((segment) => segment === TEST_DIRECTORY);

const isSourceDirectory = (directory: string) =>
  !isSpecialContainer(directory) && !isTestDirectoryPath(directory);

const subdividedDirectoriesAmong = (paths: readonly string[]) => {
  const directoriesHoldingSources = new Set(
    paths.filter((path) => isScript(path)).flatMap((path) => enclosingDirectoriesOf(path)),
  );
  return new Set(
    [...directoriesHoldingSources]
      .map((child) => directoryOf(child))
      .filter((directory) => isSourceDirectory(directory)),
  );
};

export const isSubdividedAmong = (paths: readonly string[]) => {
  const subdivided = subdividedDirectoriesAmong(paths);
  return (directory: string) => subdivided.has(directory);
};
