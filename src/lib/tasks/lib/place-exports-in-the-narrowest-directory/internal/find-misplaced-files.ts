import {
  fileNameOf,
  isEntryFileName,
  isWithin,
  LAYOUT_DIRECTORY_NAMES,
  SHARED_DIRECTORY_NAME,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import {
  directoryOf,
  enclosingDirectoriesOf,
  isStrictlyUnder,
  placementScopeOf,
} from "../../../shared/classify-files-by-role.ts";
import {
  FileBesideSubdirectories,
  FileOutsideModuleLayout,
  SharedFileWithOneUser,
} from "./export-placement-errors.ts";
import { isSubdividedAmong } from "./find-subdivided-directories.ts";

export const findMisplacedFiles = ({
  paths,
  importersOf,
  moduleDirectories,
  fixedFiles,
}: {
  readonly paths: readonly string[];
  readonly importersOf: (file: string) => readonly string[];
  readonly moduleDirectories: ReadonlySet<string>;
  readonly fixedFiles: ReadonlySet<string>;
}) => {
  const isSubdivided = isSubdividedAmong(paths);
  const moduleEnclosing = (directory: string) =>
    enclosingDirectoriesOf(`${directory}/`).findLast((enclosing) =>
      moduleDirectories.has(enclosing),
    );
  const sharedFilesUsing = (file: string) => {
    const sharedDirectory = directoryOf(file);
    const found = new Set<string>();
    const pending = [file];
    for (const next of pending) {
      for (const user of importersOf(next)) {
        const isNewSharedUser =
          directoryOf(user) === sharedDirectory && user !== file && !found.has(user);
        if (isNewSharedUser) {
          found.add(user);
          pending.push(user);
        }
      }
    }
    return [...found].toSorted();
  };
  const submoduleUsing = (module: string, user: string) =>
    enclosingDirectoriesOf(user).find(
      (directory) => isStrictlyUnder(directory, module) && moduleDirectories.has(directory),
    );
  const sharedFileViolationOf = (file: string, module: string) => {
    const sharedDirectory = directoryOf(file);
    const through = sharedFilesUsing(file);
    const users = [file, ...through]
      .flatMap((user) => importersOf(user))
      .filter((user) => user !== file && directoryOf(user) !== sharedDirectory);
    const isUsedOnlyInsideTheModule =
      users.length > 0 && users.every((user) => isWithin(user, module));
    if (!isUsedOnlyInsideTheModule) {
      return [];
    }
    const [part, ...otherParts] = new Set(users.map((user) => submoduleUsing(module, user)));
    if (otherParts.length > 0) {
      return [];
    }
    return [
      new SharedFileWithOneUser({
        location: file,
        module,
        ...(part === undefined ? {} : { part }),
        ...(through.length === 0 ? {} : { through }),
      }),
    ];
  };
  const violationsOutsideModulesOf = (file: string) => {
    const directory = directoryOf(file);
    const isBesideSubdirectories =
      directory === placementScopeOf(directory) && isSubdivided(directory);
    return isBesideSubdirectories ? [new FileBesideSubdirectories({ location: file })] : [];
  };
  return paths
    .filter((file) => !fixedFiles.has(file) && !isEntryFileName(fileNameOf(file)))
    .flatMap(
      (
        file,
      ): readonly (
        | FileBesideSubdirectories
        | FileOutsideModuleLayout
        | SharedFileWithOneUser
      )[] => {
        if (importersOf(file).length === 0) {
          return [];
        }
        const directory = directoryOf(file);
        const module = moduleEnclosing(directory);
        if (module === undefined) {
          return violationsOutsideModulesOf(file);
        }
        if (directory === `${module}/${SHARED_DIRECTORY_NAME}`) {
          return sharedFileViolationOf(file, module);
        }
        const isInALayoutDirectory = [...LAYOUT_DIRECTORY_NAMES].some((name) =>
          isWithin(directory, `${module}/${name}`),
        );
        return isInALayoutDirectory
          ? []
          : [new FileOutsideModuleLayout({ location: file, module })];
      },
    );
};
