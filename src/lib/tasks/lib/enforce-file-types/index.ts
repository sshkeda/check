import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { lintConfigFile } from "../../shared/declare-lint-config-task.ts";
import { ProjectQueryCachesLive } from "../../shared/provide-project-query-caches.ts";
import { fileTypeViolationsOfEachPackage } from "./internal/find-file-type-violations.ts";

export const fileTypes = Task.make({
  name: "file-types",
  run: Effect.andThen(lintConfigFile, fileTypeViolationsOfEachPackage).pipe(
    Effect.provide(ProjectQueryCachesLive),
  ),
});
