import { Effect } from "effect";

import { generatedPathsOf } from "../../../shared/record-and-grant-permissions-by-path.ts";
import { loadedLintConfigIn } from "./load-the-lint-config.ts";

export const ownedFilesAmong = (directory: string, files: readonly string[]) =>
  loadedLintConfigIn(directory).pipe(
    Effect.map((grants) => {
      const generated = generatedPathsOf(grants);
      return files.filter((file) => !generated.has(file));
    }),
    Effect.catchTag("LintConfigRefused", () => Effect.succeed(files)),
  );
