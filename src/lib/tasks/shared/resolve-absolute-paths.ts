import { Effect, FileSystem, Path } from "effect";

export const absolutePathOf = (relativePath: string) =>
  Effect.map(Path.Path, (path) => path.resolve(relativePath));

export const realPathOf = (file: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.realPath(file));
