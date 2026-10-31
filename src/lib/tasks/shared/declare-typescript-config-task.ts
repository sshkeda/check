import { Task } from "@sshkeda/task";
import { Path } from "effect";

import { inEachPackage } from "./check-each-nested-package.ts";
import { findTypeScriptConfigViolations } from "./find-unmet-typescript-config-requirements.ts";
import { quietViolations } from "./print-failures-and-keep-detail-in-the-trace.ts";
import { TYPESCRIPT_PROJECT_FILE } from "./query-the-typescript-project.ts";

export const typeScriptConfig = Task.make(
  "typescript-config",
  inEachPackage("typescript-config", ".", (packageDirectory) =>
    Path.Path.use((path) =>
      findTypeScriptConfigViolations(path.join(packageDirectory, TYPESCRIPT_PROJECT_FILE)).pipe(
        quietViolations("typescript-config"),
      ),
    ),
  ),
);
