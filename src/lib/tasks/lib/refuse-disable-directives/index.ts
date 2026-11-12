import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { inEachPackage } from "../../shared/check-each-nested-package.ts";
import { lintConfigFile } from "../../shared/declare-lint-config-task.ts";
import { typeScriptConfig } from "../../shared/declare-typescript-config-task.ts";
import { ProjectQueryCachesLive } from "../../shared/provide-project-query-caches.ts";
import { findDisableDirectivesInLintedFilesOf } from "./internal/find-disable-directives.ts";

export const directives = Task.make({
  name: "directives",
  run: Effect.andThen(
    Task.all([typeScriptConfig, lintConfigFile]),
    inEachPackage("directives", findDisableDirectivesInLintedFilesOf),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
});
