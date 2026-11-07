import {
  fileNameOf,
  isEntryFileName,
  isWithin,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import {
  SCRIPTS_DIRECTORY,
  SOURCE_DIRECTORY,
  TEST_DIRECTORY,
} from "../../../../../shared/test-home-directories.ts";
import { directoryOf } from "../../../shared/classify-files-by-role.ts";

const OTHER_HOME = "other";
const HOMES = [TEST_DIRECTORY, SCRIPTS_DIRECTORY, SOURCE_DIRECTORY] as const;

const IMPORT_POLICY_BY_HOME = {
  [TEST_DIRECTORY]: {
    checksModuleUrls: false,
    mayImportDevDependencies: true,
    mayImportTests: true,
    seesPastModuleBoundaries: ({ path }) => !isWithin(path, TEST_DIRECTORY),
  },
  [SCRIPTS_DIRECTORY]: {
    checksModuleUrls: true,
    mayImportDevDependencies: true,
    mayImportTests: true,
    seesPastModuleBoundaries: ({ path, isInAnotherPackage, moduleDirectories }) =>
      isWithin(path, SOURCE_DIRECTORY) &&
      !isInAnotherPackage &&
      isEntryFileName(fileNameOf(path)) &&
      moduleDirectories.has(directoryOf(path)),
  },
  [SOURCE_DIRECTORY]: {
    checksModuleUrls: true,
    mayImportDevDependencies: false,
    mayImportTests: false,
    seesPastModuleBoundaries: () => false,
  },
  [OTHER_HOME]: {
    checksModuleUrls: true,
    mayImportDevDependencies: true,
    mayImportTests: false,
    seesPastModuleBoundaries: () => false,
  },
} as const satisfies Readonly<
  Record<
    (typeof HOMES)[number] | typeof OTHER_HOME,
    {
      readonly checksModuleUrls: boolean;
      readonly mayImportDevDependencies: boolean;
      readonly mayImportTests: boolean;
      readonly seesPastModuleBoundaries: (imported: {
        readonly path: string;
        readonly isInAnotherPackage: boolean;
        readonly moduleDirectories: ReadonlySet<string>;
      }) => boolean;
    }
  >
>;

export const importPolicyOf = (importer: string) =>
  IMPORT_POLICY_BY_HOME[HOMES.find((home) => isWithin(importer, home)) ?? OTHER_HOME];
