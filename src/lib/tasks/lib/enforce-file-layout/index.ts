import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { ProjectQueryCachesLive } from "../../shared/provide-project-query-caches.ts";
import { fileLayoutViolationsOfEachPackage } from "./internal/check-the-layout-of-each-package.ts";

export const layout = Task.make({
  name: "layout",
  run: fileLayoutViolationsOfEachPackage.pipe(Effect.provide(ProjectQueryCachesLive)),
});
