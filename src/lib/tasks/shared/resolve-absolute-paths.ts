import { Effect, Path } from "effect";

export const absolutePathOf = (relativePath: string) =>
  Effect.map(Path.Path, (path) => path.resolve(relativePath));
