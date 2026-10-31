import { Effect, Path } from "effect";

import { packageCalleesIn } from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import { DeclaredUsesRefused } from "./declared-use-errors.ts";
import { findSyncCalls } from "./find-sync-calls.ts";
import { findTypeOnlySchemas } from "./find-type-only-schemas.ts";

export const findDeclaredUseViolations = <OpeningError, OpeningRequirement>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = path.dirname(yield* absolutePathOf(projectFile));
    const violations: DeclaredUsesRefused["violations"][number][] = [];
    const projects = yield* openedProjects;
    for (const project of projects) {
      for (const { sourceFile, displayName } of project.sourceFiles) {
        violations.push(
          ...findSyncCalls(
            sourceFile,
            displayName,
            yield* packageCalleesIn(project.checker, projectDirectory, sourceFile),
          ),
        );
      }
    }
    violations.push(...(yield* findTypeOnlySchemas(projects)));
    if (violations.length > 0) {
      return yield* new DeclaredUsesRefused({ violations });
    }
  }).pipe(Effect.scoped);
