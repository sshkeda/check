const RETIRED_WORDS: ReadonlySet<string> = new Set([
  "fingerprint",
  "fingerprints",
  "folder",
  "folders",
  "settings",
  "finding",
  "findings",
  "problem",
  "problems",
]);

export const retiredWordIn = (candidates: readonly string[]) =>
  candidates
    .map((candidate) => candidate.toLowerCase())
    .filter((word) => RETIRED_WORDS.has(word))
    .map((word) => ({ word }))[0];
