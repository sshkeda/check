import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, References, Schema } from "effect";

import { projectDirectory } from "../../project-directory/index.ts";
import { quietViolations } from "./print-failures-and-keep-detail-in-the-trace.ts";

const PACKAGE_MANIFEST_FILE = "package.json";

class PackageManifestMissing extends Schema.TaggedError<PackageManifestMissing>()(
  "PackageManifestMissing",
  { directory: Schema.String },
) {
  public override get message() {
    return `${this.directory} has no ${PACKAGE_MANIFEST_FILE}`;
  }
}

class RepositoryNotFound extends Schema.TaggedError<RepositoryNotFound>()("RepositoryNotFound", {
  directory: Schema.String,
}) {
  public override get message() {
    return `${this.directory} is not inside a git repository`;
  }
}

export const startDirectory = Task.make({
  name: "start-directory",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(yield* projectDirectory);
    if (!(yield* fileSystem.exists(path.join(directory, PACKAGE_MANIFEST_FILE)))) {
      return yield* new PackageManifestMissing({ directory });
    }
    yield* Task.exec("git", ["rev-parse", "--show-toplevel"], { cwd: directory }).pipe(
      Effect.provideService(References.MinimumLogLevel, "Warn"),
      Effect.catchTag("CommandFailed", () => Effect.fail(new RepositoryNotFound({ directory }))),
    );
  }).pipe(quietViolations("start-directory")),
});
