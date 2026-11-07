import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { ProjectQueryCachesLive } from "../../shared/provide-project-query-caches.ts";
import { duplicateFunctionsOfEachPackage } from "./internal/find-duplicate-functions.ts";

export const duplicateFunctions = Task.make(
  "duplicate-functions",
  duplicateFunctionsOfEachPackage.pipe(Effect.provide(ProjectQueryCachesLive)),
);
