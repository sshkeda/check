const IDENTIFIER_WORDS = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/gu;

export const identifierWords = (name: string) =>
  Array.from(name.matchAll(IDENTIFIER_WORDS), (match) => ({
    text: match[0],
    start: match.index,
  }));

export const fileNameWords = (fileName: string) => {
  const parts = fileName.replace(/^\./u, "").split(".");
  return (parts.length > 1 ? parts.slice(0, -1) : parts).flatMap((part) => part.split(/[-_]/u));
};
