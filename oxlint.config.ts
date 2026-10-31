import { lintConfig } from "./src/index.ts";

export default lintConfig({
  "docs/how-to-make-check-pass.md": { allow: ["hasAnUnlistedFileType"] },
  "src/lib/tasks/lib/lint-with-oxlint/internal/check-unsafe-enum-assignments.ts": {
    allow: ["spawnsCommands"],
  },
  "src/lib/tasks/internal/run-checks-over-one-typescript-project.ts": {
    allow: [
      {
        handlesEveryFailure:
          "runs every check over one project and reports each check's failures and crashes together, so one check failing or crashing can't hide the others",
      },
    ],
  },
  "src/lib/tasks/shared/run-tools-and-decode-their-reports.ts": { allow: ["spawnsCommands"] },
  "tests/shared/failure-as-value.ts": {
    allow: [
      {
        handlesEveryFailure:
          "tests read the failure or the outcome of the effect under test as a value to assert on it",
      },
    ],
  },
  "tests/shared/run-task-files.ts": { allow: ["usesAbbreviations"] },
  ".github": { allow: ["isAnUnlistedDirectory"] },
  ".github/workflows/publish.yml": { allow: ["hasAnUnlistedFileType"] },
});
