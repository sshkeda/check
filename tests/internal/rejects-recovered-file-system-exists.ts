import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const recovered = (recovery: string) => ({
  message: `Effect.${recovery} turns a real failure of exists into an answer; exists already answers false for a missing path`,
});

const inGenerator = (body: string) =>
  `import { Effect, FileSystem, pipe } from "effect"; export const run = Effect.gen(function* () { const fileSystem = yield* FileSystem.FileSystem; ${body} });`;

export const existsFailuresAreNotRecovered = Task.make({
  name: "no-exists-recovery refuses recovering the failures of a yielded FileSystem's exists into a success, piped, data-first, after map or as, or through a destructured exists, and leaves other recoveries, other services and other exists methods alone",
  run: ruleTest("no-exists-recovery", {
    valid: [
      inGenerator("return yield* fileSystem.exists(file);"),
      inGenerator("return yield* fileSystem.exists(file).pipe(Effect.map((found) => !found));"),
      inGenerator(
        'return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new Unreadable({ error }))));',
      ),
      inGenerator(
        'return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", () => Effect.logWarning("unreadable").pipe(Effect.as(false))));',
      ),
      inGenerator(
        'return yield* fileSystem.exists(file).pipe(Effect.catchTag("Missing", () => Effect.succeed(false)));',
      ),
      inGenerator(
        'return yield* fileSystem.exists(file).pipe(Effect.flatMap(read), Effect.catchTag("PlatformError", () => Effect.succeed(false)));',
      ),
      inGenerator("return yield* fileSystem.exists(file).pipe(Effect.result);"),
      inGenerator("return yield* fileSystem.readFileString(file).pipe(Effect.option);"),
      inGenerator(
        'return yield* Effect.gen(function* () { return yield* fileSystem.exists(file); }).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));',
      ),
      'import { Effect } from "effect"; export const run = Effect.gen(function* () { const store = yield* Store; return yield* store.exists(key).pipe(Effect.orElseSucceed(() => false)); });',
      'import { Effect, FileSystem } from "effect"; export const check = (fileSystem) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));',
      'import { Effect, FileSystem } from "other"; export const run = Effect.gen(function* () { const fileSystem = yield* FileSystem.FileSystem; return yield* fileSystem.exists(file).pipe(Effect.option); });',
      inGenerator("return Option.exists(found, (value) => value).pipe(Effect.option);"),
      inGenerator(
        "const handlers = { PlatformError: () => Effect.succeed(false) }; handlers.PlatformError = (error) => Effect.fail(error); return yield* fileSystem.exists(file).pipe(Effect.catchTags(handlers));",
      ),
      inGenerator(
        'return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", Effect.fail));',
      ),
      inGenerator(
        "return yield* fileSystem.exists(file).pipe(Effect.catchTags({ PlatformError: () => Effect.succeed(false), ...handlers }));",
      ),
      inGenerator(
        "return yield* fileSystem.exists(file).pipe(Effect.catchTags({ PlatformError: () => Effect.succeed(false), PlatformError: (error) => Effect.fail(error) }));",
      ),
      inGenerator(
        'function absent(error) { return Effect.fail(error); } return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", absent));',
      ),
      inGenerator(
        'function absent() { return Effect.succeed(false); } function recover(absent) { return fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", absent)); } return yield* recover(handler);',
      ),
      inGenerator(
        'function absent() { return Effect.succeed(false); } absent = (error) => Effect.fail(error); return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", absent));',
      ),
      inGenerator(
        'function absent() { return Effect.succeed(false); } { const absent = (error) => Effect.fail(error); return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", absent)); }',
      ),
    ],
    invalid: [
      ...[
        'function absent() { return Effect.succeed(false); } return yield* fileSystem.exists("f").pipe(Effect.catchTag("PlatformError", absent));',
        'const checked = fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", absent)); function absent() { return Effect.succeed(false); } return yield* checked;',
        'function absent() { return Effect.succeed(false); } const recover = absent; return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", recover));',
      ].map((body) => ({ code: inGenerator(body), errors: [recovered("catchTag")] })),
      {
        code: 'import { Effect, FileSystem } from "effect"; export const run = Effect.gen(function* () { const fileSystem = yield* FileSystem.FileSystem; return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", absent)); }); function absent() { return Effect.succeed(false); }',
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          "function absent() { return Effect.succeed(false); } return yield* fileSystem.exists(file).pipe(Effect.catchTags({ PlatformError: absent }));",
        ),
        errors: [recovered("catchTags")],
      },
      {
        code: inGenerator(
          "function absent() { return Effect.succeed(false); } return yield* Effect.catch(fileSystem.exists(file), absent);",
        ),
        errors: [recovered("catch")],
      },
      {
        code: inGenerator(
          "function absent() { return Effect.void; } return yield* fileSystem.exists(file).pipe(Effect.catchCause(absent));",
        ),
        errors: [recovered("catchCause")],
      },
      {
        code: inGenerator(
          'return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", Effect.succeed));',
        ),
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          'const absent = Effect.succeed(false); return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", () => absent));',
        ),
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          "const recover = Effect.catch(() => Effect.succeed(false)); return yield* recover(fileSystem.exists(file));",
        ),
        errors: [recovered("catch")],
      },
      {
        code: inGenerator(
          "return yield* (yield* FileSystem.FileSystem).exists(file).pipe(Effect.option);",
        ),
        errors: [recovered("option")],
      },
      {
        code: inGenerator(
          'return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", () => Effect.succeedNone));',
        ),
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          "return yield* fileSystem.exists(file).pipe(Effect.catchTags({ ...handlers, PlatformError: () => Effect.succeed(false) }));",
        ),
        errors: [recovered("catchTags")],
      },
      {
        code: 'import { Effect, FileSystem } from "effect"; const TAG = "PlatformError"; const absent = () => Effect.succeed(false); const recover = Effect.catchTag(TAG, absent); export const run = Effect.gen(function* () { const fileSystem = yield* FileSystem.FileSystem; return yield* fileSystem.exists(file).pipe(recover); });',
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          "return yield* Effect.catch(() => Effect.succeed(false))(fileSystem.exists(file));",
        ),
        errors: [recovered("catch")],
      },
      {
        code: inGenerator(
          'return yield* fileSystem.exists(file).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));',
        ),
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          'return yield* fileSystem.exists(file).pipe(Effect.map((found) => !found), Effect.catchTag("PlatformError", () => Effect.succeed(true)));',
        ),
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          'return yield* fileSystem.exists(file).pipe(Effect.catchTag(["PlatformError", "Other"], () => { return Effect.succeed(false); }));',
        ),
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          "return yield* fileSystem.exists(file).pipe(Effect.catchTags({ PlatformError: () => Effect.succeed(false) }));",
        ),
        errors: [recovered("catchTags")],
      },
      {
        code: inGenerator(
          'return yield* Effect.catchTag(fileSystem.exists(file), "PlatformError", () => Effect.succeed(false));',
        ),
        errors: [recovered("catchTag")],
      },
      {
        code: inGenerator(
          "return yield* fileSystem.exists(file).pipe(Effect.catch(() => Effect.succeed(false)));",
        ),
        errors: [recovered("catch")],
      },
      {
        code: inGenerator(
          "return yield* fileSystem.exists(file).pipe(Effect.catchCause(() => Effect.void));",
        ),
        errors: [recovered("catchCause")],
      },
      {
        code: inGenerator(
          "return yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));",
        ),
        errors: [recovered("orElseSucceed")],
      },
      {
        code: inGenerator(
          "return yield* Effect.orElseSucceed(fileSystem.exists(file), () => false);",
        ),
        errors: [recovered("orElseSucceed")],
      },
      {
        code: inGenerator("return yield* fileSystem.exists(file).pipe(Effect.option);"),
        errors: [recovered("option")],
      },
      {
        code: inGenerator("return yield* Effect.option(Effect.as(fileSystem.exists(file), true));"),
        errors: [recovered("option")],
      },
      {
        code: inGenerator(
          "return yield* pipe(fileSystem.exists(file), Effect.map((found) => !found), Effect.option);",
        ),
        errors: [recovered("option")],
      },
      {
        code: inGenerator(
          "return yield* fileSystem.exists(file).pipe(Effect.map((found) => !found)).pipe(Effect.option);",
        ),
        errors: [recovered("option")],
      },
      {
        code: 'import { Effect, FileSystem } from "effect"; export const run = Effect.gen(function* () { const { exists } = yield* FileSystem.FileSystem; return yield* exists(file).pipe(Effect.option); });',
        errors: [recovered("option")],
      },
      {
        code: 'import { Effect } from "effect"; import { FileSystem } from "effect/FileSystem"; export const run = Effect.gen(function* () { const fileSystem = yield* FileSystem; return yield* fileSystem.exists(file).pipe(Effect.option); });',
        errors: [recovered("option")],
      },
    ],
  }),
});
