import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { typeScriptConfig } from "../../shared/declare-typescript-config-task.ts";
import { typesCheckedInEachPackage } from "./internal/check-types-with-bun-check.ts";

export const typeCheck = Task.make({
  name: "type-check",
  run: Effect.andThen(typeScriptConfig, typesCheckedInEachPackage),
});
