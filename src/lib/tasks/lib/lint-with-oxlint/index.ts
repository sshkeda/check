import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { inEachPackage } from "../../shared/check-each-nested-package.ts";
import { lintConfigFile } from "../../shared/declare-lint-config-task.ts";
import { typeScriptConfig } from "../../shared/declare-typescript-config-task.ts";
import { ProjectQueryCachesLive } from "../../shared/provide-project-query-caches.ts";
import { checkLintRulesWithOxlintIn } from "./internal/check-lint-rules-with-oxlint.ts";

export const oxlint = Task.make(
  "oxlint",
  Effect.andThen(
    Task.all([typeScriptConfig, lintConfigFile]),
    inEachPackage("oxlint", checkLintRulesWithOxlintIn),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
);
