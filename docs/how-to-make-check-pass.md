# How to Make Check Pass

Fix the cause of each failure, keep the code simple, make program output clear and prevent mistakes from happening again.

Check may not catch every violation of these principles. Review your code against this guide.

## Meet the requirement behind the error

- Use a grant only for an unavoidable exception.
- Design for the current requirement as if you were starting fresh. Delete code the new design doesn't need.
- Grant `isGeneratedByATool` only to a file a tool generates, and name the tool in its reason.

## Grant a permission

Grant a permission to one file or directory in `oxlint.config.ts`. The key is the path from the folder that holds `oxlint.config.ts`, with no glob. Each name in `allow` lifts one ban for that path only.

```ts
export default lintConfig({
  "src/config.ts": { allow: ["readsConfig"] },
  "src/internal/run-all-checks.ts": {
    allow: [
      { handlesEveryFailure: "reports every check's failures together, so none hides another" },
    ],
  },
});
```

These names need no reason:

- `readsConfig`: Allows Effect `Config`, `process.env` and `process.argv`.
- `spawnsCommands`: Allows Effect `ChildProcess`, `Bun.spawn` and `spawn` from `node:child_process`.
- `locksFiles`: Allows `open` from `node:fs/promises` and `constants` from `node:fs`.
- `importsDynamically`: Allows `import()` and `createRequire(…).resolve`.
- `exitsTheProcess`: Allows `process.exit`.
- `usesSqlDatabases`: Allows Effect SQL.
- `writesToTheTerminal`: Allows Effect `Stdio`.
- `usesAbbreviations`: Allows abbreviations in variable, function, type and other declared names.
- `pollsWithADeadline`: Allows `Effect.repeat` with `Schedule.spaced`, under a deadline.
- `hasAnUnlistedFileType`: Allows a file type Check doesn't list, such as Markdown.
- `isAnUnlistedDirectory`: Allows a directory Check doesn't list, such as `vendor`.
- `patchesADependency`: Allows a patch file from `bun patch`.

These names need a reason, written as `{ name: "reason" }`:

- `trustsUnverifiedTypes`: Allows trusting a value's type without checking it, through `Schema.declare`.
- `handlesEveryFailure`: Allows catching every error, through `Effect.catch`, `Effect.exit`, a forked fiber or `Effect.runPromise`.
- `isGeneratedByATool`: Check skips this path, so it can't have any other permission.

A reason can't be blank.

## Make the code explain itself

- Use what Effect, Bun or a dependency already provides.
- Write each fact or decision once and derive the rest from it.
- Give each value a name that says what it holds.
- Let TypeScript infer types, or derive them from values and schemas you already use. Don't create a schema only to name a type.
- Validate unchecked data with a Schema before treating it as a typed value. A type assertion doesn't validate data.
- Name errors so they say what went wrong.
- Keep code near the files that use it. Extract shared code when other files need it.

## Make program output clear

- Follow Git and uv's style. Say what failed, name the affected file or value and explain the cause.
- Give the reader enough context to choose a fix. In a CLI people run by hand, add a hint only for a known command they can paste and run.
- Report each cause once. Put the main failure first, supporting details below it and internal debugging details in the trace.
- Preserve useful messages from underlying tools, including error codes and exact names.
- Write short, full sentences. Use periods instead of semicolons between sentences.

## Prevent the same mistake

When the user corrects a mistake, consider adding a lint rule or test to prevent it, or changing an existing rule if it enforces the wrong requirement.
