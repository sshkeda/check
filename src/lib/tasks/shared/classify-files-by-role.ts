import type { Path } from "effect";

import {
  fileNameOf,
  isEntryFileName,
  isWithin,
  LAYOUT_DIRECTORY_NAMES,
} from "../../../shared/match-file-names-and-path-prefixes.ts";
import {
  SCRIPTS_DIRECTORY,
  SOURCE_DIRECTORY,
  TEST_DIRECTORY,
} from "../../../shared/test-home-directories.ts";
import { PACKAGE_MANIFEST_FILE } from "./find-named-package-manifests.ts";
import { toolFileIsPlaced } from "./tool-file-locations.ts";

export const SCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

export const joinedWithAnd = (items: readonly string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(items);

export const hasExtension = (path: string, extensions: readonly string[]) =>
  extensions.some((extension) => path.endsWith(extension));

export const isScript = (path: string) => hasExtension(path, SCRIPT_EXTENSIONS);

const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

export const isDeclarationFile = (path: string) => DECLARATION_FILE.test(path);

const TYPESCRIPT_SOURCE_FILE = /\.tsx?$/u;

export const isTypeScriptSourceFile = (path: string) =>
  TYPESCRIPT_SOURCE_FILE.test(path) && !isDeclarationFile(path);

export const isPackageManifest = (path: string) => fileNameOf(path) === PACKAGE_MANIFEST_FILE;

export const directoryOf = (path: string) => path.split("/").slice(0, -1).join("/");

export const isTopLevelScript = (path: string) => {
  const [directory, fileName, ...nested] = path.split("/");
  return (
    directory === SCRIPTS_DIRECTORY &&
    fileName !== undefined &&
    nested.length === 0 &&
    isScript(fileName)
  );
};

export const isUnderTestDirectory = (path: string) => isWithin(path, TEST_DIRECTORY);

export const isTestEntryFile = (path: string) =>
  isUnderTestDirectory(path) && isScript(path) && !isDeclarationFile(path);

export const isRootSupportFile = (path: string) => !path.includes("/") && toolFileIsPlaced(path);

export const isSpecialContainer = (directory: string) =>
  directory === "" || directory === SCRIPTS_DIRECTORY;

export const isStrictlyUnder = (directory: string, scope: string) =>
  directory !== scope && (scope === "" || directory.startsWith(`${scope}/`));

export const enclosingDirectoriesOf = (path: string) => {
  const segments = directoryOf(path)
    .split("/")
    .filter((segment) => segment !== "");
  return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
};

export const SOURCE_NEVER_IMPORTS_SCRIPTS = {
  path: SOURCE_DIRECTORY,
  cannotImport: [SCRIPTS_DIRECTORY],
} as const;

export const repeatsSourceNeverImportsScripts = (grantPath: string, target: string) =>
  isWithin(grantPath, SOURCE_NEVER_IMPORTS_SCRIPTS.path) &&
  SOURCE_NEVER_IMPORTS_SCRIPTS.cannotImport.some((banned) => isWithin(target, banned));

const isLayoutDirectory = (directory: string) => LAYOUT_DIRECTORY_NAMES.has(fileNameOf(directory));

export const moduleDirectoriesAmong = (paths: readonly string[]) =>
  new Set(
    paths
      .filter((path) => isEntryFileName(fileNameOf(path)))
      .map((path) => directoryOf(path))
      .filter(
        (directory) =>
          directory !== "" &&
          !enclosingDirectoriesOf(`${directory}/`).some((enclosing) =>
            isLayoutDirectory(enclosing),
          ),
      ),
  );

export const directoriesNestedInLayoutDirectoriesOf = (path: string) =>
  enclosingDirectoriesOf(path).filter((directory) => isLayoutDirectory(directoryOf(directory)));

export const placementScopeOf = (directory: string) => {
  const layoutDirectory = enclosingDirectoriesOf(`${directory}/`).findLast((enclosing) =>
    isLayoutDirectory(enclosing),
  );
  return layoutDirectory === undefined ? directory : directoryOf(layoutDirectory);
};

const RELATIVE_SPECIFIER = /^\.{1,2}\//u;

export const isFileSpecifier = (specifier: string) =>
  RELATIVE_SPECIFIER.test(specifier) || specifier.startsWith("/");

export const packagePathOf = (path: Path.Path, packageDirectory: string, file: string) =>
  path.relative(packageDirectory, file).split(path.sep).join("/");
