import { Task } from "@sshkeda/task";
import { Effect, Path, Schema } from "effect";

import { projectDirectory } from "../../../../project-directory/index.ts";
import { inEachPackage, packageDirectoriesIn } from "../../../shared/check-each-nested-package.ts";
import { startDirectory } from "../../../shared/declare-start-directory-task.ts";
import { ownedFilesAmong } from "../../../shared/list-owned-files.ts";
import { listedPackageFiles } from "../../../shared/list-package-files.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { ProjectQueryCachesLive } from "../../../shared/provide-project-query-caches.ts";
import { locatedFromTheProject } from "../../../shared/report-paths-from-the-project.ts";
import { unformattedFilesAmong } from "./check-formatting-with-bun-fmt.ts";
import { checkedFormatConfigIn } from "./find-format-config-violations.ts";
import { checkedFormatInputsIn } from "./find-format-input-violations.ts";

const ownedFilesOfPackage = (checkedProject: string, packageDirectory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = path.join(checkedProject, packageDirectory);
    const { packageFiles } = yield* listedPackageFiles(directory, []);
    return { directory: packageDirectory, files: yield* ownedFilesAmong(directory, packageFiles) };
  });

const FilesOfEachPackage = Schema.Struct({
  checkedProject: Schema.String,
  filesOfEachPackage: Schema.Array(
    Schema.Struct({ directory: Schema.String, files: Schema.Array(Schema.String) }),
  ),
  packageFiles: Schema.Array(Schema.String),
});

const formatterFiles = Task.make({
  name: "formatter-files",
  output: FilesOfEachPackage,
  run: Effect.gen(function* () {
    yield* startDirectory;
    const path = yield* Path.Path;
    const checkedProject = yield* projectDirectory;
    const filesOfEachPackage = yield* Effect.forEach(
      yield* packageDirectoriesIn(checkedProject),
      (packageDirectory) => ownedFilesOfPackage(checkedProject, packageDirectory),
      { concurrency: "unbounded" },
    );
    return {
      checkedProject,
      filesOfEachPackage,
      packageFiles: filesOfEachPackage
        .flatMap(({ directory, files }) => files.map((file) => path.join(directory, file)))
        .toSorted(),
    };
  }).pipe(
    quietViolations("formatter-files"),
    locatedFromTheProject,
    Effect.provide(ProjectQueryCachesLive),
  ),
});

const formatInputs = Task.make({
  name: "format-inputs",
  run: Effect.flatMap(formatterFiles, ({ filesOfEachPackage }) =>
    inEachPackage("format-inputs", (packageDirectory, packageDirectoryFromTheProject) =>
      checkedFormatInputsIn(
        packageDirectory,
        filesOfEachPackage.find(({ directory }) => directory === packageDirectoryFromTheProject)
          ?.files ?? [],
      ).pipe(quietViolations("format-inputs")),
    ),
  ),
});

const unformattedFiles = Task.make({
  name: "bun-fmt",
  run: Effect.andThen(
    inEachPackage("bun-fmt", (packageDirectory) =>
      checkedFormatConfigIn(packageDirectory).pipe(quietViolations("bun-fmt")),
    ),
    Effect.flatMap(formatterFiles, ({ checkedProject, packageFiles }) =>
      unformattedFilesAmong(checkedProject, packageFiles),
    ),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const formatting = Task.make({
  name: "formatting",
  run: Task.allSettled([formatInputs, unformattedFiles]),
});
