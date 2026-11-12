# How to Make Check Pass

Fix the cause of each failure, keep the code simple, make program output clear and prevent mistakes from happening again.

Check may not catch every violation of these principles. Review your code against this guide.

## Meet the requirement behind the error

- Use a grant only for an unavoidable exception. [How to Grant a Permission](how-to-grant-a-permission.md) lists each grant and what it allows.
- Move the code that needs a grant into its own small file and grant that file. A grant covers the whole file, so Check stops reporting that ban for everything else in it.
- Design for the current requirement as if you were starting fresh. Delete code the new design doesn't need.
- Handle a forked effect's failure before the fork, or keep the fiber and join it.
- Return a fixed value only for the one failure you expect, such as a file that isn't there. Let every other failure fail.
- Grant `isGeneratedByATool` only to a file a tool generates.

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
- Give the reader enough context to choose a fix.
- Put a fix in the message only when it is concrete and takes no thought, such as a command to paste and run or the exact code to write. Leave out any fix that needs a decision.
- Report each cause once. Put the main failure first, supporting details below it and internal debugging details in the trace.
- Preserve useful messages from underlying tools, including error codes and exact names.
- Write short, full sentences. Use periods instead of semicolons between sentences.

## Prevent the same mistake

When the user corrects a mistake, consider adding a lint rule or test to prevent it, or changing an existing rule if it enforces the wrong requirement.
