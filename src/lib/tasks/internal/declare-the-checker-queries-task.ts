import { Task } from "@sshkeda/task";
import { Effect, Path } from "effect";

import { findImportBoundaryViolations } from "../lib/check-import-boundaries/index.ts";
import { findDeclaredUseViolations } from "../lib/check-uses-by-their-declarations/index.ts";
import { findLayerProvidesOutsideProgramStarts } from "../lib/confine-layer-provides-to-program-starts/index.ts";
import { findUngrantedStdioUses } from "../lib/confine-stdio-to-granted-files/index.ts";
import { findInferrableAnnotations } from "../lib/detect-inferrable-annotations/index.ts";
import { findRepeatedServiceYields } from "../lib/detect-repeated-service-yields/index.ts";
import { findIndexReExportViolations } from "../lib/judge-index-re-exports/index.ts";
import { findExportPlacementViolations } from "../lib/place-exports-in-the-narrowest-directory/index.ts";
import { findErrorMappingsToDone } from "../lib/refuse-error-mappings-that-end-streams/index.ts";
import { findUnobservedForkFailures } from "../lib/refuse-forks-whose-failures-nothing-observes/index.ts";
import { findServiceLayerViolations } from "../lib/require-separate-service-layers/index.ts";
import { inEachPackage } from "../shared/check-each-nested-package.ts";
import { lintConfigFile } from "../shared/declare-lint-config-task.ts";
import { typeScriptConfig } from "../shared/declare-typescript-config-task.ts";
import { ProjectQueryCachesLive } from "../shared/provide-project-query-caches.ts";
import { TYPESCRIPT_PROJECT_FILE } from "../shared/query-the-typescript-project.ts";
import { runChecksOverOneTypeScriptProject } from "./run-checks-over-one-typescript-project.ts";

export const checkerQueries = Task.make(
  "checker-queries",
  Effect.andThen(
    Task.all([typeScriptConfig, lintConfigFile]),
    inEachPackage("checker-queries", (packageDirectory) =>
      Path.Path.use((path) =>
        runChecksOverOneTypeScriptProject(path.join(packageDirectory, TYPESCRIPT_PROJECT_FILE), {
          "service-yields": findRepeatedServiceYields,
          "service-layers": findServiceLayerViolations,
          stdio: findUngrantedStdioUses,
          "inferrable-annotations": findInferrableAnnotations,
          "import-boundaries": findImportBoundaryViolations,
          "declared-uses": findDeclaredUseViolations,
          "export-placement": findExportPlacementViolations,
          "layer-provides": findLayerProvidesOutsideProgramStarts,
          "error-mappings": findErrorMappingsToDone,
          "fork-failures": findUnobservedForkFailures,
          "re-exports": findIndexReExportViolations,
        }),
      ),
    ),
  ).pipe(Effect.provide(ProjectQueryCachesLive)),
);
