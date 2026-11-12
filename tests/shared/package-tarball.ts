import { Task } from "@sshkeda/task";
import { Effect, Path } from "effect";

export const packedTarballInto = (destination: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const packedTarball = yield* Task.exec("bun", [
      "pm",
      "pack",
      "--quiet",
      "--destination",
      destination,
    ]);
    return path.resolve(destination, path.basename(packedTarball.trim()));
  });

export const peerDependenciesAtDevelopmentVersions = (
  devDependencies: Readonly<Record<string, string>>,
  peerDependencies: Readonly<Record<string, string>>,
) =>
  Object.fromEntries(
    Object.entries(devDependencies).filter(
      ([dependencyName]) => dependencyName in peerDependencies,
    ),
  );
