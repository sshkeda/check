# Check

Check sends your AI slop code back to the kitchen!

Check holds your TypeScript code to a strict standard built around Effect and Bun, so the code stays type-safe, observable and predictable.

It runs about 310 lint rules, 65 of them its own, and about 80 checks on your project's layout, imports and config. It also runs oxfmt, Effect's diagnostics and `bun check`. Your agent keeps fixing what it reports until the slop is gone.

No comment or setting turns a rule off everywhere. A small set of rules was picked to allow an override, and you grant each one to a single file in `oxlint.config.ts`. See [How to Grant a Permission](docs/how-to-grant-a-permission.md).

Check is a command you run in your repo. It runs its checks with [Task](https://github.com/sshkeda/task), a task runner for Bun.

## See it catch slop

Here's a typical agent-written function in `src/index.ts`.

```ts
export const loadUser = async (id: string) => {
  try {
    const response = await fetch(`/users/${id}`);
    return (await response.json()) as any;
  } catch (error) {
    // TODO: handle this properly
    console.log(error);
    return null;
  }
};
```

TypeScript accepts it. Check doesn't.

Here's what Check prints when it runs on that code:

```
[check] started
...
[effect-tsgo] src/index.ts:1:25: error effect(asyncFunction): This code declares an async function, consider representing this async control flow with Effect values and `Effect.gen`.
[effect-tsgo] src/index.ts:3:28: error effect(globalFetch): This code uses the global `fetch` function, HTTP requests are represented through `HttpClient` from `effect/http`.
[effect-tsgo] error ToolExited: effect-tsgo exited with code 1
[oxlint] src/index.ts:1:25: error sshkeda(no-index-logic): index file holds an arrow function expression
[oxlint] src/index.ts:4:5: error typescript(no-unsafe-return): Unsafe return of a value of type `any`.
[oxlint] src/index.ts:4:12: error typescript(consistent-type-assertions): Do not use any type assertions.
[oxlint] src/index.ts:4:19: error sshkeda(no-unchecked-parsing): json() parses JSON without a Schema
[oxlint] src/index.ts:4:39: error typescript(no-explicit-any): Unexpected `any`. Specify a different type.
[oxlint] src/index.ts:6:5: error sshkeda(no-comments): comment in code
[oxlint] src/index.ts:7:5: error eslint(no-console): Unexpected console statement.
[oxlint] error ToolExited: oxlint exited with code 1
[typed-checks] error SettledTasksFailed: 2 of 6 tasks failed: oxlint, effect-tsgo
[check] read node_modules/@sshkeda/check/docs/how-to-make-check-pass.md before you change the code
[check] error SettledTasksFailed: 1 of 7 tasks failed: typed-checks
failed: effect-tsgo, oxlint (2 of 18 tasks), 1.0s
...
```

Here's what each error catches:

- The `any` and the type assertion switch off type checking.
- The JSON is never validated.
- The async function and the bare `fetch` hide their errors from Effect.
- The comment and the `console.log` are leftovers.

Check points your agent to [How to Make Check Pass](docs/how-to-make-check-pass.md), which explains how to write code that passes.

Here's the same function after your agent fixes it. The code now lives in `src/internal/load-user.ts`:

```ts
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

const User = Schema.Struct({ id: Schema.String, name: Schema.String });

export const loadUser = (id: string) =>
  HttpClient.get(`/users/${id}`).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(User)));
```

`src/index.ts` only exports it:

```ts
export { loadUser } from "./internal/load-user.ts";
```

Check passes.

## Why these rules

- **No comments.** When code is hard to follow, the fix is better names and simpler code, which stay true as the code changes. Comments drift out of date, and agents fill them with noise. When you need more explanation, ask your agent to explain the code.
- **No `type` or `interface` declarations.** Types are inferred from the code that produces each value, so every type has one source of truth and nothing to keep in sync.
- **No `let`, and no `while` or counting `for` loops.** Values don't change after they're made, which leaves an agent fewer ways to get state wrong.
- **Modules with `internal/`, `shared/` and `lib/`.** Each module exposes its public code in `index.ts`, keeps private code in `internal/`, which only that module may import, puts code its parts share in `shared/` and holds its child modules in `lib/`. Code stays easy to organize and hard to tangle.
- **No abbreviations.** `imABigFanWhenVariablesAreLongBecauseThenItsEasierToUnderstandWhatTheCodeDoes`. Full words read the same to every person and every agent.
- **No unchecked data.** JSON and other input pass through a Schema before the code trusts them, because a type assertion or a hand-written type guard proves nothing.
- **No dead exports.** Check reports any export that nothing uses, or that only tests use, so unused code doesn't pile up. It also reports an export in `src/` that only tests and scripts use, so code that tests or deploys your app lives in `tests/` or `scripts/`. A script still counts as a user of what `src/index.ts` exports, such as your app's entry point, and of a file it builds.
- **Effect in place of Node's built-ins.** File, path and process work goes through Effect, so its errors stay typed.
- **Tests are tasks.** Every test is a Task task in `tests/`, never a Vitest, Jest or `bun:test` suite. Tests run in parallel and clean up after themselves.
- **Each service in its own layer.** Services are declared only in files you grant, which keeps their wiring in one place.
- **No polling.** Code waits for an event or a signal instead of checking on a timer, so it reacts right away. When there's nothing to listen to, such as a server that's still starting, polling needs a grant and a time limit.
- **No dropped failures.** Every error is handled or passed on, and a fork that can fail must keep its fiber, so nothing fails silently.
- **Risky access only where you grant it.** Reading environment variables, starting commands and printing to the terminal each need a grant on the exact file that does it.

## Get started

Check needs Bun 1.4.4 or newer and a Git repository.

1. Install Check, Effect and Bun's types.

   ```bash
   bun add @sshkeda/check effect
   bun add -d @types/bun
   ```

2. Add these options to `compilerOptions` in `tsconfig.json`.

   ```json
   "strict": true,
   "noUncheckedIndexedAccess": true,
   "exactOptionalPropertyTypes": true,
   "noImplicitReturns": true,
   "noUnusedLocals": true,
   "noUnusedParameters": true,
   "noPropertyAccessFromIndexSignature": true,
   "noImplicitOverride": true,
   "noFallthroughCasesInSwitch": true,
   "allowUnreachableCode": false,
   "allowUnusedLabels": false,
   "allowImportingTsExtensions": true,
   "noEmit": true,
   "types": ["bun"]
   ```

3. Create `oxlint.config.ts`, where you grant overrides to single files.

   ```ts
   import { lintConfig } from "@sshkeda/check";

   export default lintConfig({});
   ```

4. Create `oxfmt.config.ts`.

   ```ts
   import { FORMAT_CONFIG } from "@sshkeda/check";

   export default FORMAT_CONFIG;
   ```

5. Run Check, and have your agent fix what it reports. Expect the first run to fail, even on a new project from `bun init`.

   ```bash
   bunx @sshkeda/check
   ```

   Check checks the package in the directory you start it in.

   To run one check alone, name it, as in `bunx @sshkeda/check oxlint`.

## Make it yours

Check's rules are one opinion. To change them, clone the repo, add or remove rules, and use your copy instead of the npm package.

## Development

To run its checks and tests, run `bun scripts/ci.ts`. Check checks itself!

[MIT](LICENSE)
