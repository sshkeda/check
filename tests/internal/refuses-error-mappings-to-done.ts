import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { findErrorMappingsToDone } from "../../src/lib/tasks/lib/refuse-error-mappings-that-end-streams/internal/find-error-mappings-to-done.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const IMPORTS = 'import { Cause, Effect, Stream } from "effect";\n';

const violationsOf = (sources: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(sources);
    return yield* findErrorMappingsToDone(tsconfigFile, openTypeScriptProjects(tsconfigFile)).pipe(
      Effect.as(new Array<{ readonly location: string; readonly operation: string }>()),
      Effect.catchTag("ErrorMappingsRefused", ({ violations }) =>
        Effect.succeed(
          violations.map(({ location, operation }) => ({
            location: location.replace(/:\d+$/u, ""),
            operation,
          })),
        ),
      ),
    );
  }).pipe(Effect.scoped);

export const errorMappingsToDoneAreRefused = Task.make(
  "an Effect, Stream, Channel or Sink error mapping whose result can be Cause.Done is refused by its type, a helper or a union included, and mappings to ordinary failures pass",
  Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts": `${IMPORTS}export const ended = Stream.fail("failure").pipe(Stream.mapError(() => Cause.Done()), Stream.runDrain);\n`,
        "b.ts": `${IMPORTS}export const ended = Stream.fromEffectRepeat(Effect.fail("failure").pipe(Effect.mapError(() => Cause.Done()))).pipe(Stream.runDrain);\n`,
        "c.ts": `${IMPORTS}const toDone = () => Cause.Done();\nexport const ended = Stream.mapError(Stream.fail("failure"), toDone);\n`,
        "d.ts": `${IMPORTS}export const ended = Stream.fail("failure").pipe(Stream.mapError((error) => (error.length > 0 ? Cause.Done() : new Error(error))));\n`,
        "e.ts": `${IMPORTS}export const ended = Effect.fail("failure").pipe(Effect.mapBoth({ onFailure: () => Cause.Done(), onSuccess: (value) => value }));\n`,
        "f.ts": `${IMPORTS}export const mapped = Stream.fail("failure").pipe(Stream.mapError((error) => new Error(error)));\nexport const kept = Effect.fail("failure").pipe(Effect.mapError((error) => error.length));\n`,
      }),
    ).toEqual([
      { location: "a.ts:2", operation: "Stream.mapError" },
      { location: "b.ts:2", operation: "Effect.mapError" },
      { location: "c.ts:3", operation: "Stream.mapError" },
      { location: "d.ts:2", operation: "Stream.mapError" },
      { location: "e.ts:2", operation: "Effect.mapBoth" },
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);

const TAGGED_FAILURE = `import { Schema } from "effect";\nclass LineUnreadable extends Schema.TaggedError<LineUnreadable>()("LineUnreadable", {}) {}\nconst failing = Stream.fail(new LineUnreadable());\n`;

export const recoveriesThatFailWithDoneAreRefused = Task.make(
  "an Effect or Stream recovery whose handler can fail with Cause.Done is refused like an error mapping to it, a catchTags handler or a data-first call included, and recoveries to ordinary failures or values pass",
  Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts": `${IMPORTS}${TAGGED_FAILURE}export const ended = failing.pipe(Stream.catchTag("LineUnreadable", () => Stream.fail(Cause.Done())));\n`,
        "b.ts": `${IMPORTS}${TAGGED_FAILURE}export const ended = Stream.catchTag(failing, "LineUnreadable", () => Stream.fail(Cause.Done()));\n`,
        "c.ts": `${IMPORTS}${TAGGED_FAILURE}export const ended = Stream.fromEffectRepeat(Effect.fail(new LineUnreadable()).pipe(Effect.catchTag("LineUnreadable", () => Effect.fail(Cause.Done()))));\n`,
        "d.ts": `${IMPORTS}${TAGGED_FAILURE}export const ended = Stream.fromEffectRepeat(Effect.fail(new LineUnreadable()).pipe(Effect.catchTags({ LineUnreadable: () => Effect.fail(Cause.Done()) })));\n`,
        "e.ts": `${IMPORTS}${TAGGED_FAILURE}export const ended = failing.pipe(Stream.catch(() => Stream.fail(Cause.Done())));\n`,
        "f.ts": `${IMPORTS}${TAGGED_FAILURE}export const recovered = failing.pipe(Stream.catchTag("LineUnreadable", () => Stream.empty));\nexport const failed = Effect.fail(new LineUnreadable()).pipe(Effect.catch(() => Effect.fail("failure")));\n`,
      }),
    ).toEqual([
      { location: "a.ts:5", operation: "Stream.catchTag" },
      { location: "b.ts:5", operation: "Stream.catchTag" },
      { location: "c.ts:5", operation: "Effect.catchTag" },
      { location: "d.ts:5", operation: "Effect.catchTags" },
      { location: "e.ts:5", operation: "Stream.catch" },
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
);
