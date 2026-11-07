import { ReportedErrors } from "@sshkeda/task/errors";
import type { PrintableError } from "@sshkeda/task/errors";
import { Array as Arrays, Effect, Path } from "effect";
import type { PlatformError } from "effect";

import { listedPackageFiles } from "./list-package-files.ts";
import { quietViolations } from "./print-failures-and-keep-detail-in-the-trace.ts";

const CHECKED_PACKAGE = ".";

const INSTALLED_PACKAGES_DIRECTORY = "node_modules";

const isInstalledPackage = (packageDirectory: string) =>
  packageDirectory.split("/").includes(INSTALLED_PACKAGES_DIRECTORY);

const locationInPackage = (
  pathModule: Path.Path,
  packageDirectory: string,
  location: string | undefined,
) => {
  if (location === undefined) {
    return packageDirectory;
  }
  const isLocatedFromTheCheckedPackage =
    pathModule.isAbsolute(location) || location.startsWith(`${packageDirectory}/`);
  return isLocatedFromTheCheckedPackage ? location : pathModule.join(packageDirectory, location);
};

const locatedInPackage = (
  pathModule: Path.Path,
  packageDirectory: string,
  printable: PrintableError,
): PrintableError =>
  packageDirectory === CHECKED_PACKAGE
    ? printable
    : {
        tag: printable.tag,
        location: locationInPackage(pathModule, packageDirectory, printable.location),
        message: printable.message,
      };

const distinctPrintedErrors = (printables: readonly PrintableError[]) => {
  const printedByLocation = new Map<string | undefined, Set<string>>();
  return printables.filter(({ tag, location, message }) => {
    const printed = printedByLocation.get(location) ?? new Set<string>();
    printedByLocation.set(location, printed);
    const printedLine = `${tag}: ${message}`;
    const isFirstPrinted = !printed.has(printedLine);
    printed.add(printedLine);
    return isFirstPrinted;
  });
};

export const packageDirectoriesIn = (directory: string) =>
  listedPackageFiles(directory, []).pipe(
    Effect.map(({ nestedPackageDirectories }) => [
      CHECKED_PACKAGE,
      ...nestedPackageDirectories.filter((nested) => !isInstalledPackage(nested)),
    ]),
  );

export const inEachPackage = <Requirements>(
  tool: string,
  directory: string,
  checkPackage: (
    packageDirectory: string,
  ) => Effect.Effect<void, PlatformError.PlatformError | ReportedErrors, Requirements>,
) =>
  Effect.gen(function* () {
    const pathModule = yield* Path.Path;
    const packageDirectories = yield* packageDirectoriesIn(directory).pipe(quietViolations(tool));
    const reportedByPackage = yield* Effect.forEach(
      packageDirectories,
      (packageDirectory) =>
        checkPackage(pathModule.join(directory, packageDirectory)).pipe(
          Effect.as([]),
          Effect.catchTag("ReportedErrors", ({ reportedErrors }) =>
            Effect.succeed(
              reportedErrors.map((printable) =>
                locatedInPackage(pathModule, packageDirectory, printable),
              ),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    const reportedErrors = distinctPrintedErrors(reportedByPackage.flat());
    if (Arrays.isArrayNonEmpty(reportedErrors)) {
      return yield* new ReportedErrors({ reportedErrors });
    }
  });
