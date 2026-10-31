import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Predicate } from "effect";

import { findDeclaredUseViolations } from "../../src/lib/tasks/lib/check-uses-by-their-declarations/internal/find-declared-use-violations.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const BLOCKING_PACKAGE = {
  "node_modules/blocking/package.json": '{ "name": "blocking", "types": "index.d.ts" }\n',
  "node_modules/blocking/index.d.ts": `export declare class Store {
  loadSync(key: string): string;
  load(key: string): Promise<string>;
}
export declare function fetchSync(url: string): string;
export declare const sync: (url: string) => string;
export declare function decodeSync(text: string): string;
export declare function writeFileSync(file: string, text: string): void;
`,
} as const;

const syncCallsIn = (tsconfigFile: string) =>
  findDeclaredUseViolations(tsconfigFile, openTypeScriptProjects(tsconfigFile)).pipe(
    Effect.as(new Array<string>()),
    Effect.catchTag("DeclaredUsesRefused", (failure) =>
      Effect.succeed(
        failure.violations
          .filter((violation) => Predicate.isTagged(violation, "SyncCall"))
          .map((violation) => `${violation.location} ${violation.message}`),
      ),
    ),
  );

export const syncCallsNeedASyncGrant = Task.make(
  "the declared-uses check reports a call to any package function or method whose declared name ends in Sync, called directly, destructured or aliased, in every file, and leaves in-memory sync functions and the named sync reads and writes to their own rules",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      ...BLOCKING_PACKAGE,
      "load.ts": `import { decodeSync, fetchSync, Store, sync, writeFileSync } from "blocking";
const store = new Store();
export const loaded = store.loadSync("a");
const { loadSync } = store;
export const destructured = loadSync("a");
const fetchNow = fetchSync;
export const fetched = fetchNow("a");
export const later = store.load("a");
export const plain = sync("a");
export const decoded = decodeSync("a");
writeFileSync("a", "b");
const localSync = () => 1;
export const local = localSync();
`,
      "other.ts": `import { Store } from "blocking";
export const loaded = new Store().loadSync("a");
`,
    });
    expect((yield* syncCallsIn(tsconfigFile)).toSorted()).toEqual([
      "load.ts:3 Store.loadSync runs synchronously",
      "load.ts:5 Store.loadSync runs synchronously",
      "load.ts:7 fetchSync runs synchronously",
      "other.ts:2 Store.loadSync runs synchronously",
    ]);
  }).pipe(Effect.scoped),
);
