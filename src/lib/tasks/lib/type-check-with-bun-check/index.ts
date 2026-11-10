import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { inEachPackage } from "../../shared/check-each-nested-package.ts";
import { typeScriptConfig } from "../../shared/declare-typescript-config-task.ts";
import { checkTypesWithBunCheckIn } from "./internal/check-types-with-bun-check.ts";

export const typeCheck = Task.make(
  "type-check",
  Effect.andThen(typeScriptConfig, inEachPackage("type-check", checkTypesWithBunCheckIn)),
);
