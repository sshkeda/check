import { ReportedErrors } from "@sshkeda/task/errors";
import type { PrintableError } from "@sshkeda/task/errors";
import { Array as Arrays, Effect, Path } from "effect";

import { printableError } from "../../../shared/format-reported-failures.ts";
import { projectDirectory } from "../../project-directory/index.ts";

const locationFromTheProject = (
  pathModule: Path.Path,
  checkedProject: string,
  location: string,
) => {
  if (!pathModule.isAbsolute(location)) {
    return location;
  }
  const fromTheProject = pathModule.relative(checkedProject, location);
  const isInsideTheProject =
    fromTheProject !== "" &&
    !fromTheProject.startsWith("..") &&
    !pathModule.isAbsolute(fromTheProject);
  return isInsideTheProject ? fromTheProject : location;
};

const locatedWith = Effect.gen(function* () {
  const pathModule = yield* Path.Path;
  const checkedProject = pathModule.resolve(
    yield* projectDirectory.pipe(
      Effect.mapError(
        (configError) => new ReportedErrors({ reportedErrors: [printableError(configError)] }),
      ),
    ),
  );
  return ({ tag, location, message }: PrintableError): PrintableError => ({
    tag,
    ...(location === undefined
      ? {}
      : { location: locationFromTheProject(pathModule, checkedProject, location) }),
    message,
  });
});

export const printedFromTheProject = (printables: readonly PrintableError[]) =>
  locatedWith.pipe(Effect.map((located) => printables.map((printable) => located(printable))));

export const locatedFromTheProject = <Success, Requirements>(
  effect: Effect.Effect<Success, ReportedErrors, Requirements>,
) =>
  effect.pipe(
    Effect.catchTag("ReportedErrors", ({ reportedErrors }) =>
      locatedWith.pipe(
        Effect.flatMap((located) =>
          Effect.fail(new ReportedErrors({ reportedErrors: Arrays.map(reportedErrors, located) })),
        ),
      ),
    ),
  );
