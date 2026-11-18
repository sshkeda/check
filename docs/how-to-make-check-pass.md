# How to Make Check Pass

Each rule removes one way to write code that is wrong, hidden or hard to change, so one correct way stays.

Fix the cause of each failure and keep the code simple. Use a grant only for an unavoidable exception. [How to Grant a Permission](how-to-grant-a-permission.md) lists each grant and what it allows.

Each rule serves one of three goals.

## Type-safe

TypeScript knows the true type of every value. Each type has one source, and data from outside the program is checked where it enters.

- Let TypeScript infer types, or derive them from values and schemas you already use. Don't create a schema only to name a type.
- Validate unchecked data with a Schema before treating it as a typed value. A type assertion doesn't validate data.
- Use the known type for data the program made or already checked. Don't decode it again or make it `unknown`.

## Observable

You can see what the program does and why it fails. Every failure has a name and goes to a caller. Risky access is visible and limited.

- Handle a forked effect's failure before the fork, or keep the fiber and join it.
- Wrap a Promise in `Effect.tryPromise` and `yield*` it instead of using `await`.
- Return a fixed value only for the one failure you expect, such as a file that isn't there. Let every other failure fail.
- Name errors so they say what went wrong.

### Make program output clear

- Follow Git and uv's style. Say what failed, name the affected file or value and explain the cause.
- Give the reader enough context to choose a fix.
- Put a fix in the message only when it is concrete and takes no thought, such as a command to paste and run or the exact code to write. Leave out any fix that needs a decision.
- Report each cause once. Put the main failure first, supporting details below it and internal debugging details in the trace.
- Preserve useful messages from underlying tools, including error codes and exact names.
- Write short, full sentences. Use periods instead of semicolons between sentences.

## Predictable

The code has one shape. Values do not change after they are made. Names stay true when the code changes.

- Design for the current requirement as if you were starting fresh. Delete code the new design doesn't need.
- Use what Effect, Bun or a dependency already provides.
- Write each fact or decision once and derive the rest from it.
- Give each value a name that says what it holds.
- Keep code near the files that use it. Extract shared code when other files need it.
- Read a fact from where a tool states it, such as an error's fields, a command's exit code or its JSON output. Text written for people changes between releases, and code that searches it breaks quietly when it does.
- Write a job that moves through stages as an explicit state machine, with one tagged case per stage in one union, so the job is always in exactly one stage.

## Decide if a rule is worth it

When the user corrects a mistake, consider a rule or a test that prevents it. A rule is worth building when all of these are true:

1. It serves one of the three goals.
2. It removes a way to be wrong and does not add one.
3. One correct way stays.
4. It catches a real problem. Run it on real projects to confirm.

A change that loosens a rule adds a way. Make it only when the rule rejects code that already meets the goal.
