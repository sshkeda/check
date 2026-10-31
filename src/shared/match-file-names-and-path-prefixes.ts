const ENTRY_FILE_NAMES: ReadonlySet<string> = new Set(["index.ts", "index.tsx"]);

export const isWithin = (path: string, enclosingPath: string) =>
  path === enclosingPath || path.startsWith(`${enclosingPath}/`);

export const fileNameOf = (path: string) => path.split("/").at(-1) ?? path;

export const directoryHolding = (file: string) => file.slice(0, file.lastIndexOf("/"));

export const isEntryFileName = (fileName: string) => ENTRY_FILE_NAMES.has(fileName);

export const SHARED_DIRECTORY_NAME = "shared";
export const INTERNAL_DIRECTORY_NAME = "internal";
export const LIBRARY_DIRECTORY_NAME = "lib";
export const LAYOUT_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  SHARED_DIRECTORY_NAME,
  INTERNAL_DIRECTORY_NAME,
]);
