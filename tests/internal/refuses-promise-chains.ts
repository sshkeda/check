import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { findPromiseChains } from "../../src/lib/tasks/lib/refuse-promise-chains/internal/find-promise-chains.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const violationsOf = (sources: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(sources);
    return yield* findPromiseChains(tsconfigFile, openTypeScriptProjects(tsconfigFile)).pipe(
      Effect.as(new Array<{ readonly location: string; readonly method: string }>()),
      Effect.catchTag("PromiseChainsRefused", ({ violations }) =>
        Effect.succeed(
          violations.map(({ location, method }) => ({
            location: location.replace(/:\d+$/u, ""),
            method,
          })),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const chained = (location: string, method: string) => ({ location, method });

export const promiseChainsAreRefused = Task.make({
  name: "a then, catch or finally call on a Promise is refused once for each call in a chain, on fetch, under tests, after an optional chain, as an optional call or by a string key, and inside Effect.tryPromise too",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts":
          "export const settle = (promise: Promise<number>) => {\n  void promise.then((value) => value + 1);\n  void promise.catch(() => 0);\n  void promise.finally(() => undefined);\n};\n",
        "b.ts":
          'export const length = fetch("https://example.com")\n  .then((response) => response.text())\n  .then((text) => text.length)\n  .catch(() => 0);\n',
        "c.ts":
          'import { Effect } from "effect";\nconst load = () => Promise.resolve(1);\nexport const loaded = Effect.tryPromise({\n  try: () => load().then((value) => value + 1),\n  catch: () => "failed",\n});\n',
        "d.ts":
          'export const later = (promise: Promise<number> | undefined) => promise?.then((value) => value);\nexport const maybe = (promise: Promise<number>) => promise.then?.((value) => value);\nexport const keyed = (promise: Promise<number>) => promise["then"]((value) => value);\n',
        "tests/a.ts": "export const settled = Promise.resolve(1).finally(() => undefined);\n",
      }),
    ).toEqual([
      chained("a.ts:2", "then"),
      chained("a.ts:3", "catch"),
      chained("a.ts:4", "finally"),
      chained("b.ts:2", "then"),
      chained("b.ts:3", "then"),
      chained("b.ts:4", "catch"),
      chained("c.ts:4", "then"),
      chained("d.ts:1", "then"),
      chained("d.ts:2", "then"),
      chained("d.ts:3", "then"),
      chained("tests/a.ts:1", "finally"),
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const thenablesAreRefused = Task.make({
  name: "a then, catch or finally call on any thenable is refused like one on a Promise, whether it is a class with its own then, a class that extends Promise, a union that includes a Promise or a value whose then is optional",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts":
          "class Query {\n  then(onFulfilled: (rows: readonly string[]) => void) {\n    onFulfilled([]);\n  }\n}\nexport const rows = new Query().then(() => undefined);\n",
        "b.ts":
          "class Pending extends Promise<number> {}\nexport const settle = (pending: Pending) => pending.finally(() => undefined);\n",
        "c.ts":
          "export const settle = (value: Promise<number> | { readonly finally: (handler: () => void) => void }) =>\n  value.finally(() => undefined);\n",
        "d.ts":
          "export const format = (promise: Partial<PromiseLike<number>>) => promise.then?.(String);\n",
      }),
    ).toEqual([
      chained("a.ts:6", "then"),
      chained("b.ts:2", "finally"),
      chained("c.ts:2", "finally"),
      chained("d.ts:1", "then"),
    ]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const chainsByAComputedKeyAreRefused = Task.make({
  name: "a then, catch or finally call on a Promise by a computed key whose type is that method's name is refused, and one by a key typed string or on a value that is not thenable passes",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts":
          'const method = "then";\nexport const keyed = (promise: Promise<number>) => promise[method](String);\nexport const either = (promise: Promise<number>, key: "catch") => promise[key](() => 0);\n',
        "b.ts":
          "export const first = (calls: readonly (() => number)[]) => calls[0]?.();\nexport const read = (record: Record<string, () => number>, key: string) => record[key]?.();\nexport const loose = (promise: Promise<number> & Record<string, () => void>, key: string) => promise[key]?.();\n",
      }),
    ).toEqual([chained("a.ts:2", "then"), chained("a.ts:3", "catch")]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const callsOnValuesThatAreNotThenablePass = Task.make({
  name: "Effect.catch and Stream.catch pass by name, through a renamed import, through a namespace import of effect/Effect or inside a pipe, as do catch and finally on an object literal and catch on a class instance that have no then, and any call whose receiver is any or unresolved",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "a.ts":
          'import { Effect, Stream } from "effect";\nexport const direct = Effect.catch(Effect.fail("failure"), () => Effect.succeed(0));\nexport const piped = Effect.fail("failure").pipe(Effect.catch(() => Effect.succeed(0)));\nexport const stream = Stream.fail("failure").pipe(Stream.catch(() => Stream.empty));\n',
        "b.ts":
          'import { Effect as Work } from "effect";\nexport const renamed = Work.catch(Work.fail("failure"), () => Work.succeed(0));\n',
        "c.ts":
          'import * as Effect from "effect/Effect";\nexport const namespaced = Effect.fail("failure").pipe(Effect.catch(() => Effect.succeed(0)));\n',
        "d.ts":
          "const handler = { catch: (fallback: number) => fallback, finally: () => undefined };\nexport const caught = handler.catch(1);\nexport const finished = handler.finally();\n",
        "e.ts":
          'class TextSchema {\n  catch(fallback: string) {\n    return fallback;\n  }\n}\nexport const schema = new TextSchema().catch("default");\n',
        "f.ts":
          "export const loose = (value: any) => value.then(() => 0);\nexport const unresolved = () => missing.then(() => 0);\n",
      }),
    ).toEqual([]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const promiseChainsAreNamed = Task.make({
  name: "the report names the method called on the Promise at the method's location",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "a.ts":
        "export const settle = (promise: Promise<number>) => {\n  void promise.then((value) => value + 1);\n};\n",
    });
    const messages = yield* findPromiseChains(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("PromiseChainsRefused", ({ violations }) =>
        Effect.succeed(violations.map(({ location, message }) => `${location}: ${message}`)),
      ),
    );
    expect(messages).toEqual(["a.ts:2:16: then is called on a Promise"]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

const CALLS_ON_ONE_RECEIVER_TYPE = 3;

export const eachReceiverTypeIsReadOnce = Task.make({
  name: "calls in two files on receivers of the same type have that type read for a then once between them",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "a.ts":
        "export const pending = Promise.resolve(1);\nvoid pending.then(String);\nvoid pending.catch(String);\n",
      "b.ts": 'import { pending } from "./a.ts";\nvoid pending.finally(() => undefined);\n',
    });
    const opened = yield* openTypeScriptProjects(tsconfigFile);
    const readTypes: unknown[] = [];
    for (const { checker } of opened) {
      const apparentTypeOf = checker.getApparentType.bind(checker);
      checker.getApparentType = (type) => {
        readTypes.push(type);
        return apparentTypeOf(type);
      };
    }
    const reported = yield* findPromiseChains(tsconfigFile, Effect.succeed(opened)).pipe(
      Effect.as(0),
      Effect.catchTag("PromiseChainsRefused", ({ violations }) =>
        Effect.succeed(violations.length),
      ),
    );
    expect(reported).toBe(CALLS_ON_ONE_RECEIVER_TYPE);
    expect(readTypes).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});
