import { Task } from "@sshkeda/task";
import { Effect, Path } from "effect";

import { inEachPackage, packageDirectoriesIn } from "../../../shared/check-each-nested-package.ts";
import { ownedFilesAmong } from "../../../shared/list-owned-files.ts";
import { listedPackageFiles } from "../../../shared/list-package-files.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { ProjectQueryCachesLive } from "../../../shared/provide-project-query-caches.ts";
import {
  FORMATTED_PACKAGE_DIRECTORY,
  unformattedFilesAmong,
} from "./check-formatting-with-bun-fmt.ts";
import { checkedFormatConfigIn } from "./find-format-config-violations.ts";
import { checkedFormatInputsIn } from "./find-format-input-violations.ts";

const ownedFilesOfPackage = (packageDirectory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = path.join(FORMATTED_PACKAGE_DIRECTORY, packageDirectory);
    const { packageFiles } = yield* listedPackageFiles(directory, []);
    return { directory, files: yield* ownedFilesAmong(directory, packageFiles) };
  });

const formatterFiles = Task.make(
  "formatter-files",
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const filesOfEachPackage = yield* Effect.forEach(
      yield* packageDirectoriesIn(FORMATTED_PACKAGE_DIRECTORY),
      ownedFilesOfPackage,
      { concurrency: "unbounded" },
    );
    return {
      filesOfEachPackage,
      packageFiles: filesOfEachPackage
        .flatMap(({ directory, files }) => files.map((file) => path.join(directory, file)))
        .toSorted(),
    };
  }).pipe(quietViolations("formatter-files"), Effect.provide(ProjectQueryCachesLive)),
);

const formatInputs = Task.make(
  "format-inputs",
  Effect.flatMap(formatterFiles, ({ filesOfEachPackage }) =>
    inEachPackage("format-inputs", FORMATTED_PACKAGE_DIRECTORY, (packageDirectory) =>
      checkedFormatInputsIn(
        packageDirectory,
        filesOfEachPackage.find(({ directory }) => directory === packageDirectory)?.files ?? [],
      ).pipe(quietViolations("format-inputs")),
    ),
  ),
);

const unformattedFiles = Task.make(
  "bun-fmt",
  Effect.andThen(
    inEachPackage("bun-fmt", FORMATTED_PACKAGE_DIRECTORY, (packageDirectory) =>
      checkedFormatConfigIn(packageDirectory).pipe(quietViolations("bun-fmt")),
    ),
    Effect.flatMap(formatterFiles, ({ packageFiles }) => unformattedFilesAmong(packageFiles)),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
);

export const formatting = Task.make(
  "formatting",
  Task.allSettled([formatInputs, unformattedFiles]),
);
