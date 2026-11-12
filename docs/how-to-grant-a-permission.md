# How to Grant a Permission

Grant a permission to one file or directory in `oxlint.config.ts`. The key is the path from the folder that holds `oxlint.config.ts`, with no glob. Each name in `allow` lifts one ban for that path only.

```ts
export default lintConfig({
  "src/config.ts": { allow: ["readsConfig"] },
  "src/internal/run-all-checks.ts": { allow: ["handlesEveryFailure"] },
});
```

- `readsConfig`: Allows Effect `Config`, `process.env` and `process.argv`.
- `spawnsCommands`: Allows Effect `ChildProcess`, `Bun.spawn` and `spawn` from `node:child_process`.
- `locksFiles`: Allows `open` from `node:fs/promises` and `constants` from `node:fs`.
- `importsDynamically`: Allows `import()` and `createRequire(…).resolve`.
- `exitsTheProcess`: Allows `process.exit`.
- `usesSqlDatabases`: Allows Effect SQL.
- `writesToTheTerminal`: Allows Effect `Stdio`.
- `usesAbbreviations`: Allows abbreviations in variable, function, type and other declared names.
- `pollsWithADeadline`: Allows `Effect.repeat` and `Effect.retry` with `Schedule.spaced` or `Schedule.exponential`, under a deadline. `Schedule.exponential` may be wrapped in or piped through `Schedule.jittered`.
- `waitsOnTimers`: Allows `Effect.sleep`, `Effect.delay`, `Clock.sleep` and the Stream operations that wait on a timer, such as `Stream.tick`.
- `hasAnUnlistedFileType`: Allows a file type Check doesn't list, such as Markdown.
- `isAnUnlistedDirectory`: Allows a directory Check doesn't list, such as `.github`. Check doesn't apply its directory-shape rules inside it, but files there still need their own `hasAnUnlistedFileType` grant.
- `patchesADependency`: Allows a patch file from `bun patch`.
- `trustsUnverifiedTypes`: Allows trusting a value's type without checking it, through `Schema.declare`.
- `handlesEveryFailure`: Allows catching every error, through `Effect.catch`, `Effect.exit`, a forked fiber or `Effect.runPromise`.
- `fallsBackToFixedValues`: Allows answering every failure, or a whole library error such as `PlatformError`, with a fixed value that never reads the failure.
- `isGeneratedByATool`: Check skips this path, so it can't have any other permission.
