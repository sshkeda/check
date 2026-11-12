import { lintConfig } from "./src/index.ts";

export default lintConfig({
  "docs/how-to-grant-a-permission.md": { allow: ["hasAnUnlistedFileType"] },
  "docs/how-to-make-check-pass.md": { allow: ["hasAnUnlistedFileType"] },
  "scripts/check.ts": { allow: ["readsConfig"] },
  "src/lib/project-directory/internal/read-the-project-directory.ts": { allow: ["readsConfig"] },
  "src/lib/tasks/lib/lint-with-oxlint/internal/check-unsafe-enum-assignments.ts": {
    allow: ["spawnsCommands"],
  },
  "src/lib/tasks/internal/run-checks-over-one-typescript-project.ts": {
    allow: ["handlesEveryFailure"],
  },
  "src/lib/tasks/shared/run-tools-and-decode-their-reports.ts": {
    allow: ["spawnsCommands", "readsConfig", "locksFiles"],
  },
  "src/lib/tasks/shared/create-the-module-resolver.ts": { services: ["ModuleResolvers"] },
  "src/lib/tasks/shared/query-the-typescript-project.ts": {
    services: ["TypeScriptProjectListings"],
  },
  "src/lib/tasks/shared/resolve-module-requests.ts": { services: ["ModuleResolutions"] },
  "src/lib/tasks/shared/watch-the-typescript-api-process.ts": {
    allow: ["handlesEveryFailure", "trustsUnverifiedTypes", "usesAbbreviations"],
    services: ["TypeScriptApiLaunch"],
  },
  "tests/shared/failure-as-value.ts": { allow: ["handlesEveryFailure"] },
  "tests/shared/run-task-files.ts": { allow: ["usesAbbreviations"] },
  ".github": { allow: ["isAnUnlistedDirectory"] },
  ".github/workflows/publish.yml": { allow: ["hasAnUnlistedFileType"] },
});
