import { Task } from "@sshkeda/task";
import { Effect, Path } from "effect";

import { layout } from "../lib/enforce-file-layout/index.ts";
import { fileTypes } from "../lib/enforce-file-types/index.ts";
import { formatting } from "../lib/format-with-bun-fmt/index.ts";
import { lintConfigFile } from "../shared/declare-lint-config-task.ts";
import { typeScriptConfig } from "../shared/declare-typescript-config-task.ts";
import { typedChecks } from "./declare-the-typed-checks-task.ts";

const GUIDE_FILE = new URL("../../../../docs/how-to-make-check-pass.md", import.meta.url);

const pointAtTheGuide = Effect.gen(function* () {
  const path = yield* Path.Path;
  const guide = path.relative(path.resolve("."), yield* path.fromFileUrl(GUIDE_FILE));
  yield* Effect.logError(`read ${guide} before you change the code`);
});

export const check: Task.Task<void> = Task.make(
  "check",
  Task.allSettled([
    typeScriptConfig,
    lintConfigFile,
    typedChecks,
    formatting,
    layout,
    fileTypes,
  ]).pipe(Effect.tapError(() => pointAtTheGuide)),
);
