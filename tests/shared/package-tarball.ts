import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

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

const LOCAL_FILE_PREFIX = "file:";

export const peerDependenciesAtDevelopmentVersions = (
  devDependencies: Readonly<Record<string, string>>,
  peerDependencies: Readonly<Record<string, string>>,
  destination: string,
  manifestDirectory: string,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const peers = Object.entries(devDependencies).filter(
      ([dependencyName]) => dependencyName in peerDependencies,
    );
    return Object.fromEntries(
      yield* Effect.forEach(peers, ([dependencyName, version]) =>
        Effect.gen(function* () {
          if (!version.startsWith(LOCAL_FILE_PREFIX)) {
            return [dependencyName, version] as const;
          }
          const source = version.slice(LOCAL_FILE_PREFIX.length);
          const copied = path.join(destination, path.basename(source));
          yield* fileSystem.copyFile(source, copied);
          return [
            dependencyName,
            `${LOCAL_FILE_PREFIX}${path.relative(manifestDirectory, copied)}`,
          ] as const;
        }),
      ),
    );
  });
