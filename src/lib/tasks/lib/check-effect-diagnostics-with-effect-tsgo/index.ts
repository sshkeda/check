import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { inEachPackage } from "../../shared/check-each-nested-package.ts";
import { lintConfigFile } from "../../shared/declare-lint-config-task.ts";
import { typeScriptConfig } from "../../shared/declare-typescript-config-task.ts";
import { ProjectQueryCachesLive } from "../../shared/provide-project-query-caches.ts";
import { effectDiagnosticsIn } from "./internal/check-effect-diagnostics-with-effect-tsgo.ts";

export const effectStrict = Task.make(
  "effect-tsgo",
  Effect.andThen(
    Task.all([typeScriptConfig, lintConfigFile]),
    inEachPackage("effect-tsgo", effectDiagnosticsIn),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
);
