import { fileURLToPath } from "node:url";

import { Effect, Path } from "effect";

export const oxlintBinary = Effect.gen(function* () {
  const path = yield* Path.Path;
  const manifest = fileURLToPath(import.meta.resolve("oxlint/package.json"));
  return path.join(path.dirname(manifest), "bin", "oxlint");
});
