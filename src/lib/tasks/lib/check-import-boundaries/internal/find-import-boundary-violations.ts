import { Effect, FileSystem, Path, Result, Schema } from "effect";
import { parseSync } from "oxc-parser";

import { fileNameOf, isWithin } from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import { TEST_DIRECTORY } from "../../../../../shared/test-home-directories.ts";
import {
  isFileSpecifier,
  isScript,
  directoriesNestedInLayoutDirectoriesOf,
  moduleDirectoriesAmong,
  packagePathOf,
  repeatsSourceNeverImportsScripts,
  SOURCE_NEVER_IMPORTS_SCRIPTS,
} from "../../../shared/classify-files-by-role.ts";
import { lineNumbersIn } from "../../../shared/count-the-line-of-an-offset.ts";
import {
  moduleRequestsIn,
  moduleUrlMisusesIn,
  URL_REQUESTS,
} from "../../../shared/find-module-requests.ts";
import type { MODULE_REQUEST_KINDS } from "../../../shared/find-module-requests.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";
import { ignoredPackagePathsAmong } from "../../../shared/list-ignored-files-imported-by-source.ts";
import { loadedLintConfigIn } from "../../../shared/load-the-lint-config.ts";
import { PackageManifestFieldInvalid } from "../../../shared/project-config-and-tool-errors.ts";
import {
  checkedSourceFiles,
  includedFiles,
  programFiles,
  CUSTOM_CONDITIONS,
  effectiveCompilerOptions,
} from "../../../shared/query-the-typescript-project.ts";
import { packageManifestObject } from "../../../shared/read-package-manifest-object.ts";
import { resolveModuleRequest } from "../../../shared/resolve-module-requests.ts";
import { importPolicyOf } from "./decide-what-each-home-may-import.ts";
import { packageRequestBehindSubpathImport } from "./find-subpath-import-targets.ts";
import { whatHidesTheImport } from "./find-what-hides-an-import.ts";
import type { IMPORT_BOUNDARY_VIOLATION } from "./import-boundary-errors.ts";
import {
  CannotImportCrossed,
  DevDependencyImported,
  ImportBoundariesCrossed,
  ImportOutsidePackage,
  ModuleInternalsImported,
  PlainDirectoryImported,
  PrivateCodeImported,
  ImportCaseMismatch,
  ImportOfMissingIgnoredFile,
  ImportResolvesToNoFile,
  ModulePathFromDirectory,
  ModuleUrlNotInline,
  ModuleUrlPassedToFunction,
  TestImported,
} from "./import-boundary-errors.ts";

const NODE_MODULES_DIRECTORY = "node_modules";
const REQUESTS_BUN_CHECK_RESOLVES = new Set<(typeof MODULE_REQUEST_KINDS)[number]>([
  "static",
  "type",
  "dynamic",
]);

const BARE_PACKAGE_NAME = /^(?:@[^/]+\/)?[^/.][^/]*/u;

const importsPackageEntry = (
  specifier: string,
  resolved: NonNullable<Effect.Success<ReturnType<typeof resolveModuleRequest>>>,
) =>
  !isFileSpecifier(specifier) &&
  resolved.packageName !== null &&
  BARE_PACKAGE_NAME.exec(specifier)?.[0] === resolved.packageName &&
  (resolved.packageHasExports || specifier === resolved.packageName);

const DEPENDENCY_LIST = Schema.optionalKey(Schema.Record(Schema.String, Schema.Json));
const DEPENDENCY_LISTS = Schema.Struct({
  dependencies: DEPENDENCY_LIST,
  devDependencies: DEPENDENCY_LIST,
  peerDependencies: DEPENDENCY_LIST,
  optionalDependencies: DEPENDENCY_LIST,
});

const dependencyNamesIn = (packageDirectory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestFile = path.join(packageDirectory, PACKAGE_MANIFEST_FILE);
    const manifest = yield* Effect.fromResult(
      packageManifestObject(manifestFile, yield* fileSystem.readFileString(manifestFile)),
    );
    const lists = yield* Schema.decodeEffect(DEPENDENCY_LISTS)(manifest).pipe(
      Effect.mapError(
        (error) => new PackageManifestFieldInvalid({ path: manifestFile, reason: error.message }),
      ),
    );
    const installedWithThePackage = new Set(
      [lists.dependencies, lists.peerDependencies, lists.optionalDependencies].flatMap((list) =>
        Object.keys(list ?? {}),
      ),
    );
    const development = Object.keys(lists.devDependencies ?? {});
    return {
      declared: new Set([...installedWithThePackage, ...development]),
      devOnly: new Set(development.filter((name) => !installedWithThePackage.has(name))),
    };
  });

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/u;
const withoutScriptExtension = (file: string) => file.replace(SCRIPT_EXTENSION, "");

const visibilityViolationOf = (
  importerPath: string,
  importedPath: string,
  moduleDirectories: ReadonlySet<string>,
  location: string,
  otherPackageDirectory: string | undefined,
) => {
  const hidden = whatHidesTheImport(
    importerPath,
    importedPath,
    moduleDirectories,
    otherPackageDirectory,
  );
  if (hidden === undefined) {
    return;
  }
  const isHiddenByAModuleOrPackage = hidden.hiddenBy === "module" || hidden.hiddenBy === "package";
  if (isHiddenByAModuleOrPackage) {
    return new ModuleInternalsImported({
      location,
      importedPath,
      module: hidden.directory,
      kind: hidden.hiddenBy,
    });
  }
  if (hidden.hiddenBy === "internal") {
    return new PrivateCodeImported({
      location,
      importedPath,
      directory: hidden.directory,
      module: hidden.parent,
    });
  }
  const isReportedByTheLayoutCheck = directoriesNestedInLayoutDirectoriesOf(importedPath).includes(
    hidden.directory,
  );
  if (isReportedByTheLayoutCheck) {
    return;
  }
  return new PlainDirectoryImported({
    location,
    importedPath,
    directory: hidden.directory,
    parent: hidden.parent,
  });
};

export const findImportBoundaryViolations = (projectFile: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const grants = yield* loadedLintConfigIn(path.dirname(projectFile));
    const boundaries = [
      SOURCE_NEVER_IMPORTS_SCRIPTS,
      ...grants
        .map((grant) => ({
          path: grant.path,
          cannotImport: grant.cannotImport.filter(
            (target) => !repeatsSourceNeverImportsScripts(grant.path, target),
          ),
        }))
        .filter((boundary) => boundary.cannotImport.length > 0),
    ];
    const packageDirectory = yield* fileSystem.realPath(path.dirname(projectFile));
    const { customConditions = [] } = yield* Schema.decodeEffect(CUSTOM_CONDITIONS)(
      yield* effectiveCompilerOptions(projectFile),
    );
    const placeOf = (fileName: string) => {
      const relativePath = path.relative(packageDirectory, fileName);
      const segments = relativePath.split(path.sep);
      if (segments.includes(NODE_MODULES_DIRECTORY)) {
        return { installed: true } as const;
      }
      const isOutsideThePackage = relativePath.startsWith("..") || path.isAbsolute(relativePath);
      return isOutsideThePackage
        ? ({ outside: true } as const)
        : ({ packagePath: segments.join("/") } as const);
    };
    const checkedFiles = yield* checkedSourceFiles(projectFile);
    const dependencies = yield* dependencyNamesIn(packageDirectory);
    const typeCheckedFiles = new Set(yield* programFiles(projectFile));
    const includedByTheProject = yield* includedFiles(projectFile);
    const moduleDirectories = moduleDirectoriesAmong(checkedFiles);
    const violations = new Map<string, typeof IMPORT_BOUNDARY_VIOLATION.Type>();
    const unresolved: {
      location: string;
      specifier: string;
      missingPath: string;
      isTypeChecked: boolean;
      isReportedByNoRequireImports: boolean;
    }[] = [];
    const addViolation = (found: typeof IMPORT_BOUNDARY_VIOLATION.Type) =>
      violations.set(`${found.location} ${found.message}`, found);
    const violationsIn = (displayName: string) =>
      Effect.gen(function* () {
        const found: (typeof IMPORT_BOUNDARY_VIOLATION.Type)[] = [];
        const add = (violation: typeof IMPORT_BOUNDARY_VIOLATION.Type) => {
          found.push(violation);
        };
        const unresolvedInFile = new Array<(typeof unresolved)[number]>();
        const text = yield* fileSystem.readFileString(path.join(packageDirectory, displayName));
        const parsed = parseSync(displayName, text);
        const lineAt = lineNumbersIn(text);
        const policy = importPolicyOf(displayName);
        const bans = boundaries.flatMap((boundary) =>
          isWithin(displayName, boundary.path)
            ? boundary.cannotImport
                .filter((target) => !isWithin(displayName, target))
                .map((target) => ({
                  target,
                  grantPath: boundary.path,
                  isBuiltIn: boundary === SOURCE_NEVER_IMPORTS_SCRIPTS,
                }))
            : [],
        );
        if (policy.checksModuleUrls) {
          const { misuses, directoryPaths } = moduleUrlMisusesIn(parsed);
          for (const { start, ...misuse } of misuses) {
            const location = `${displayName}:${lineAt(start)}`;
            add(
              "callee" in misuse
                ? new ModuleUrlPassedToFunction({ location, callee: misuse.callee })
                : new ModuleUrlNotInline({ location, usage: misuse.usage }),
            );
          }
          for (const { start, property } of directoryPaths) {
            add(
              new ModulePathFromDirectory({
                location: `${displayName}:${lineAt(start)}`,
                property,
              }),
            );
          }
        }
        const importingFile = path.join(packageDirectory, displayName);
        const { requests, reportedByNoRequireImports } = moduleRequestsIn(parsed);
        for (const request of requests) {
          if (request.kind === "build") {
            continue;
          }
          const resolvesAPackage =
            request.kind === "resolve" && !isFileSpecifier(request.specifier);
          const isUrlToNonScript =
            URL_REQUESTS.has(request.kind) && !isScript(request.specifier) && !resolvesAPackage;
          if (isUrlToNonScript) {
            continue;
          }
          const location = `${displayName}:${lineAt(request.start)}`;
          const isTypeChecked =
            REQUESTS_BUN_CHECK_RESOLVES.has(request.kind) && typeCheckedFiles.has(displayName);
          const specifierText = request.specifier;
          const resolved = yield* resolveModuleRequest({
            request: specifierText,
            importingFile,
            customConditions,
            projectDirectory: packageDirectory,
          });
          if (resolved === undefined) {
            if (isFileSpecifier(specifierText)) {
              unresolvedInFile.push({
                location,
                specifier: specifierText,
                missingPath: packagePathOf(
                  path,
                  packageDirectory,
                  path.resolve(path.dirname(importingFile), specifierText),
                ),
                isTypeChecked,
                isReportedByNoRequireImports: reportedByNoRequireImports.has(request.start),
              });
            }
            continue;
          }
          const written = withoutScriptExtension(
            path.resolve(path.dirname(importingFile), specifierText),
          );
          const actual = withoutScriptExtension(resolved.file);
          const importedFile = path.relative(packageDirectory, resolved.file);
          const differsFromWrittenPathOnlyInCase =
            !(isTypeChecked && includedByTheProject.has(importedFile)) &&
            isFileSpecifier(specifierText) &&
            !actual.startsWith(written) &&
            actual.toLowerCase().startsWith(written.toLowerCase());
          if (differsFromWrittenPathOnlyInCase) {
            add(
              new ImportCaseMismatch({
                location,
                specifier: specifierText,
                importedFile,
              }),
            );
          }
          const isUrlLoad = request.kind === "url" || request.kind === "launch";
          const { packageName, packageRoot } = resolved;
          const requestedPackage = BARE_PACKAGE_NAME.exec(specifierText)?.[0];
          const isDeclaredDependency =
            requestedPackage !== undefined && dependencies.declared.has(requestedPackage);
          const dependencyName = isDeclaredDependency ? requestedPackage : packageName;
          const isDevOnlyPackageImportedBySource =
            !isUrlLoad &&
            !policy.mayImportDevDependencies &&
            dependencyName !== null &&
            packageRoot !== packageDirectory &&
            dependencies.devOnly.has(dependencyName);
          if (isDevOnlyPackageImportedBySource) {
            add(
              new DevDependencyImported({
                location,
                specifier: specifierText,
                packageName: dependencyName,
              }),
            );
          }
          const place = placeOf(resolved.file);
          const packageRequest = yield* packageRequestBehindSubpathImport({
            request: specifierText,
            importingFile,
            customConditions,
            projectDirectory: packageDirectory,
          });
          const importedThroughPackage = importsPackageEntry(
            packageRequest ?? specifierText,
            resolved,
          );
          const importsFileOutsidePackage = "outside" in place && !importedThroughPackage;
          if (importsFileOutsidePackage) {
            add(
              new ImportOutsidePackage({
                location,
                specifier: specifierText,
                importedFile: resolved.file,
              }),
            );
          }
          if (!("packagePath" in place)) {
            continue;
          }
          const importedPath = place.packagePath;
          const isRefusedTestImport =
            isWithin(importedPath, TEST_DIRECTORY) && !policy.mayImportTests;
          if (isRefusedTestImport) {
            add(new TestImported({ location, importedPath }));
          }
          if (isUrlLoad) {
            continue;
          }
          const crossedBans = bans.filter((candidate) => isWithin(importedPath, candidate.target));
          for (const ban of crossedBans) {
            add(
              new CannotImportCrossed({
                location,
                importedPath,
                grantPath: ban.grantPath,
                target: ban.target,
              }),
            );
          }
          if (isRefusedTestImport) {
            continue;
          }
          const isResolvedIntoAnotherPackage =
            packageRoot !== null && packageRoot !== packageDirectory;
          const isExemptFromVisibilityCheck =
            crossedBans.some((ban) => ban.isBuiltIn) ||
            (importedThroughPackage && packageRoot !== packageDirectory) ||
            fileNameOf(importedPath) === PACKAGE_MANIFEST_FILE ||
            policy.seesPastModuleBoundaries({
              path: importedPath,
              isInAnotherPackage: isResolvedIntoAnotherPackage,
              moduleDirectories,
            });
          const hidden = isExemptFromVisibilityCheck
            ? undefined
            : visibilityViolationOf(
                displayName,
                importedPath,
                moduleDirectories,
                location,
                isResolvedIntoAnotherPackage
                  ? packagePathOf(path, packageDirectory, packageRoot)
                  : undefined,
              );
          if (hidden !== undefined) {
            add(hidden);
          }
        }
        return { found, unresolvedInFile };
      });
    const scannedFiles = yield* Effect.forEach(
      checkedFiles,
      (displayName) =>
        violationsIn(displayName).pipe(
          Effect.map(Result.succeed),
          Effect.catchTag("ModuleRequestUnresolvable", (unresolvable) =>
            Effect.succeed(Result.fail(unresolvable)),
          ),
        ),
      { concurrency: "unbounded" },
    );
    for (const scanned of scannedFiles) {
      if (Result.isFailure(scanned)) {
        return yield* scanned.failure;
      }
      const { found, unresolvedInFile } = scanned.success;
      for (const violation of found) {
        addViolation(violation);
      }
      unresolved.push(...unresolvedInFile);
    }
    const ignored = new Set(
      yield* ignoredPackagePathsAmong(
        unresolved.map(({ missingPath }) => missingPath),
        packageDirectory,
      ),
    );
    for (const {
      location,
      specifier,
      missingPath,
      isTypeChecked,
      isReportedByNoRequireImports,
    } of unresolved) {
      const isReportedByTheTypeCheckOrNoRequireImports =
        isTypeChecked || isReportedByNoRequireImports;
      if (ignored.has(missingPath)) {
        addViolation(new ImportOfMissingIgnoredFile({ location, specifier, missingPath }));
      } else if (!isReportedByTheTypeCheckOrNoRequireImports) {
        addViolation(new ImportResolvesToNoFile({ location, specifier }));
      }
    }
    if (violations.size > 0) {
      return yield* new ImportBoundariesCrossed({ violations: [...violations.values()] });
    }
  }).pipe(Effect.scoped);
