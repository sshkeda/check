import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { lintConfigFile } from "../../shared/declare-lint-config-task.ts";
import { typeScriptConfig } from "../../shared/declare-typescript-config-task.ts";
import { ProjectQueryCachesLive } from "../../shared/provide-project-query-caches.ts";
import { lintedFilesNotTypeCheckedInEachPackage } from "./internal/find-linted-files-not-type-checked.ts";

export const lintedFilesTypeChecked = Task.make({
  name: "linted-files-type-checked",
  run: Effect.andThen(
    Task.all([typeScriptConfig, lintConfigFile]),
    lintedFilesNotTypeCheckedInEachPackage,
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
});
