import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { findFileLayoutViolations } from "../../src/lib/tasks/lib/enforce-file-layout/internal/find-file-layout-violations.ts";
import { loadedLintConfigIn } from "../../src/lib/tasks/shared/load-the-lint-config.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";

const makeProject = (
  sources: Parameters<typeof makeProjectWith>[1],
  lintConfig = "lintConfig({})",
) =>
  makeProjectWith(
    REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
    { ".gitignore": "node_modules\n", ...sources },
    lintConfig,
  );

const MISPLACED_FILES = {
  "custom.config.ts": "export const VALUE = 1;\n",
  "docs/example.ts": "export const VALUE = 1;\n",
  "src/internal/index.ts": "export const VALUE = 1;\n",
  "src/index.ts": "export const VALUE = 1;\n",
} as const;

export const filePlacementCannotBeGranted = Task.make(
  "misplaced files are reported, and a file-location grant that would lift their placement is refused as an unknown permission",
  Effect.gen(function* () {
    const ungranted = yield* makeProject(MISPLACED_FILES);
    const violations = yield* findFileLayoutViolations(ungranted.directory).pipe(failureAsValue);
    expect(violations._tag).toBe("FileLayoutViolations");
    expect(violations.message).toContain("custom.config.ts");
    expect(violations.message).toContain("docs/example.ts");
    expect(violations.message).toContain("src/internal/index.ts");
    const granted = yield* makeProject(
      MISPLACED_FILES,
      'lintConfig({ "custom.config.ts": { allow: ["file-location"] } })',
    );
    const refusal = yield* loadedLintConfigIn(granted.directory).pipe(failureAsValue);
    expect(refusal._tag).toBe("LintConfigRefused");
    expect(refusal.message).toContain('"custom.config.ts".allow[0]: Expected "readsConfig"');
    expect(refusal.message).toContain('got "file-location"');
  }).pipe(Effect.scoped),
);
