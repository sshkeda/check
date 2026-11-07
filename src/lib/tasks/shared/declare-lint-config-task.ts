import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { inEachPackage } from "./check-each-nested-package.ts";
import { loadedLintConfigIn } from "./load-the-lint-config.ts";
import { quietViolations } from "./print-failures-and-keep-detail-in-the-trace.ts";
import { ProjectQueryCachesLive } from "./provide-project-query-caches.ts";

export const lintConfigFile = Task.make(
  "lint-config",
  inEachPackage("lint-config", ".", (packageDirectory) =>
    loadedLintConfigIn(packageDirectory).pipe(Effect.asVoid, quietViolations("lint-config")),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
);
