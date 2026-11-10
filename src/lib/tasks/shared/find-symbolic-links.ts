import { Effect, FileSystem, Predicate } from "effect";

const NOT_A_SYMBOLIC_LINK = "EINVAL";

export const isSymbolicLink = (file: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.readLink(file)).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", (error) => {
      const isNotASymbolicLink =
        Predicate.hasProperty(error.reason.cause, "code") &&
        error.reason.cause.code === NOT_A_SYMBOLIC_LINK;
      return isNotASymbolicLink ? Effect.succeed(false) : Effect.fail(error);
    }),
  );
