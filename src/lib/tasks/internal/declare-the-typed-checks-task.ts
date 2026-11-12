import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { effectStrict } from "../lib/check-effect-diagnostics-with-effect-tsgo/index.ts";
import { oxlint } from "../lib/lint-with-oxlint/index.ts";
import { directives } from "../lib/refuse-disable-directives/index.ts";
import { lintedFilesTypeChecked } from "../lib/require-type-checking-every-linted-file/index.ts";
import { typeCheck } from "../lib/type-check-with-bun-check/index.ts";
import { typeScriptConfig } from "../shared/declare-typescript-config-task.ts";
import { checkerQueries } from "./declare-the-checker-queries-task.ts";

export const typedChecks: Task.Task<void> = Task.make({
  name: "typed-checks",
  run: Effect.andThen(
    typeScriptConfig,
    Task.allSettled([
      typeCheck,
      oxlint,
      effectStrict,
      directives,
      checkerQueries,
      lintedFilesTypeChecked,
    ]),
  ),
});
