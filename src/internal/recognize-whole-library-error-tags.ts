const LIBRARY_ERROR_SUFFIX = "Error";

const LIBRARY_ERROR_TAGS_WITHOUT_THE_SUFFIX: ReadonlySet<string> = new Set(["CommandFailed"]);

export const isWholeLibraryErrorTag = (tag: string) =>
  tag.endsWith(LIBRARY_ERROR_SUFFIX) || LIBRARY_ERROR_TAGS_WITHOUT_THE_SUFFIX.has(tag);
