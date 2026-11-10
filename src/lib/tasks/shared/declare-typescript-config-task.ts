import { Task } from "@sshkeda/task";
import { ReportedErrors } from "@sshkeda/task/errors";
import type { PrintableError } from "@sshkeda/task/errors";
import { Array as Arrays, Effect, Path } from "effect";

import { inEachPackage } from "./check-each-nested-package.ts";
import { findTypeScriptConfigViolations } from "./find-unmet-typescript-config-requirements.ts";
import { quietViolations } from "./print-failures-and-keep-detail-in-the-trace.ts";
import { ProjectQueryCachesLive } from "./provide-project-query-caches.ts";
import { TYPESCRIPT_PROJECT_FILE } from "./query-the-typescript-project.ts";

const locatedFromThePackage = (
  path: Path.Path,
  packageDirectory: string,
  printable: PrintableError,
): PrintableError => {
  const { location } = printable;
  const isRelativeLocation = location !== undefined && !path.isAbsolute(location);
  if (!isRelativeLocation) {
    return printable;
  }
  const locationFromThePackage = path.relative(packageDirectory, location);
  const isOutsideThePackage = locationFromThePackage.startsWith(`..${path.sep}`);
  return isOutsideThePackage
    ? { tag: printable.tag, location: locationFromThePackage, message: printable.message }
    : printable;
};

export const typeScriptConfig = Task.make(
  "typescript-config",
  inEachPackage("typescript-config", (packageDirectory) =>
    Path.Path.use((path) =>
      findTypeScriptConfigViolations(path.join(packageDirectory, TYPESCRIPT_PROJECT_FILE)).pipe(
        quietViolations("typescript-config"),
        Effect.mapError(
          ({ reportedErrors }) =>
            new ReportedErrors({
              reportedErrors: Arrays.map(reportedErrors, (printable) =>
                locatedFromThePackage(path, packageDirectory, printable),
              ),
            }),
        ),
      ),
    ),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
);
