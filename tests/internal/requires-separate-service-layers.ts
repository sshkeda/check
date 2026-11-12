import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { findServiceLayerViolations } from "../../src/lib/tasks/lib/require-separate-service-layers/internal/find-service-layer-violations.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const IMPORTS = 'import { Context, Effect, Layer } from "effect";\n';
const STORE =
  'export class Store extends Context.Service<Store, { readonly value: number }>()("Store") {}\n';
const IMPLEMENTATION = "Layer.succeed(Store, { value: 1 })";

const violationsOf = (sources: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(sources);
    return yield* findServiceLayerViolations(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as(new Array<{ readonly tag: string; readonly service: string }>()),
      Effect.catchTag("ServiceLayersRefused", ({ violations }) =>
        Effect.succeed(
          violations.map((violation) => ({ tag: violation._tag, service: violation.service })),
        ),
      ),
    );
  }).pipe(Effect.scoped);

export const separateLayers = Task.make({
  name: "separate layer values, factories and private helpers are allowed",
  run: Effect.gen(function* () {
    expect(
      yield* violationsOf({
        "live.ts": `${IMPORTS}${STORE}export const StoreLive = ${IMPLEMENTATION};`,
        "export-list.ts": `${IMPORTS}${STORE}const live = ${IMPLEMENTATION}; export { live as StoreLive };`,
        "factory.ts": `${IMPORTS}${STORE}export const StoreLive = (value: number) => Layer.succeed(Store, { value });`,
        "function.ts": `${IMPORTS}${STORE}export function StoreLive(value: number) { return Layer.succeed(Store, { value }); }`,
        "alternative.ts": `${IMPORTS}${STORE}export const StoreTest = ${IMPLEMENTATION};`,
        "private-helper.ts": `${IMPORTS}${STORE}const makeStoreLayer = (value: number) => Layer.succeed(Store, { value }); export const StoreLive = makeStoreLayer(1);`,
        "private-layer.ts": `${IMPORTS}${STORE}const layer = ${IMPLEMENTATION}; export const StoreLive = layer;`,
        "key-only.ts": `${IMPORTS}${STORE}`,
        "unrelated.ts": `${IMPORTS}class Plain { static layer = Layer.empty; }`,
        "non-layer.ts": `${IMPORTS}export class Store extends Context.Service<Store, {}>()("Store") { static label = "store"; static make() { return Effect.void; } }`,
        "optional-data.ts": `${IMPORTS}export class Store extends Context.Service<Store, {}>()("Store") { static count?: number; static label: string | null = null; static get enabled(): boolean | undefined { return undefined; } }`,
        "alias.ts": `import { Context as Services, Layer as Layers } from "effect"; export class Store extends Services.Service<Store, {}>()("Store") {} export const StoreLive = Layers.succeed(Store, {});`,
      }),
    ).toEqual([]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const staticLayers = Task.make({
  name: "static layer fields, getters, methods and external assignments are refused by type",
  run: Effect.gen(function* () {
    const cases = [
      "static layer = Layer.succeed(Store, {});",
      "static implementation = Layer.succeed(Store, {});",
      "static get layer() { return Layer.succeed(Store, {}); }",
      "static layer() { return Layer.succeed(Store, {}); }",
      "static layer = () => Layer.succeed(Store, {});",
      'static ["layer"] = Layer.succeed(Store, {});',
      "static readonly Live: Layer.Layer<Store> = Layer.succeed(Store, {});",
      "static layer: Layer.Layer<Store> | undefined = Layer.succeed(Store, {});",
      "static layer?: Layer.Layer<Store>;",
      "static layer: Layer.Layer<Store> | null = null;",
      "static get layer(): Layer.Layer<Store> | undefined { return undefined; }",
      "static layer(): Layer.Layer<Store> | undefined { return undefined; }",
      "static layer: (() => Layer.Layer<Store>) | undefined;",
      "static layer: Layer.Layer<Store> | (() => Layer.Layer<Store>) | undefined;",
    ];
    const sources = Object.fromEntries(
      cases.map((member, index) => [
        `static-${index}.ts`,
        `${IMPORTS}export class Store extends Context.Service<Store, {}>()("Store") { ${member} }`,
      ]),
    );
    const externalSources = {
      "assigned.ts": `${IMPORTS}${STORE}Store.layer = ${IMPLEMENTATION};`,
      "computed.ts": `${IMPORTS}${STORE}Store["layer"] = ${IMPLEMENTATION};`,
      "imported.ts": `${IMPORTS}import { Store as Imported } from "./assigned.ts"; Imported.layer = Layer.succeed(Imported, { value: 1 });`,
    };
    const observed = yield* violationsOf({ ...sources, ...externalSources });
    expect(observed).toHaveLength(cases.length + Object.keys(externalSources).length);
    expect(observed.every(({ tag }) => tag === "ServiceLayerNotSeparate")).toBe(true);
    expect(observed.every(({ service }) => service === "Store")).toBe(true);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const unrestrictedNames = Task.make({
  name: "module layer names and visibility are unrestricted",
  run: Effect.gen(function* () {
    const cases = [
      `const layer = ${IMPLEMENTATION};`,
      `export const layer = ${IMPLEMENTATION};`,
      `export const StoreLayer = ${IMPLEMENTATION};`,
      `export const StoreDefault = ${IMPLEMENTATION};`,
      `export const OtherLive = ${IMPLEMENTATION};`,
      `export const layer = () => ${IMPLEMENTATION};`,
      `export default ${IMPLEMENTATION};`,
    ];
    const observed = yield* violationsOf(
      Object.fromEntries(
        cases.map((declaration, index) => [
          `named-${index}.ts`,
          `${IMPORTS}${STORE}${declaration}`,
        ]),
      ),
    );
    expect(observed).toEqual([]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});

export const logicalAssignments = Task.make({
  name: "logical assignments to imported service keys are refused without relying on their field declarations",
  run: Effect.gen(function* () {
    const operators = ["=", "??=", "||=", "&&="];
    const assignments = Object.fromEntries(
      operators.map((operator, index) => [
        `assignment-${index}.ts`,
        `import { Layer } from "effect"; import { Store as Imported } from "store-key"; Imported.layer ${operator} Layer.succeed(Imported, { value: 1 });`,
      ]),
    );
    const observed = yield* violationsOf({
      "node_modules/store-key/package.json":
        '{ "name": "store-key", "type": "module", "exports": "./index.ts" }',
      "node_modules/store-key/index.ts": `${IMPORTS}export class Store extends Context.Service<Store, { readonly value: number }>()("Store") { static layer: Layer.Layer<Store> | undefined; }`,
      ...assignments,
      "computed.ts":
        'import { Layer } from "effect"; import * as Keys from "store-key"; Keys.Store["layer"] ??= Layer.succeed(Keys.Store, { value: 1 });',
    });
    expect(observed).toHaveLength(Object.keys(assignments).length + 1);
    expect(observed.every(({ tag }) => tag === "ServiceLayerNotSeparate")).toBe(true);
    expect(observed.every(({ service }) => service === "Store")).toBe(true);
    expect(
      yield* violationsOf({
        "plain.ts": `${IMPORTS}export class Plain { static layer: Layer.Layer<never> | undefined; static initialize() { Plain.layer ??= Layer.empty; } }`,
        "scalar.ts": `${IMPORTS}export class Store extends Context.Service<Store, {}>()("Store") { static count?: number; static initialize() { Store.count ??= 1; } }`,
      }),
    ).toEqual([]);
  }).pipe(Effect.provide(ProjectQueryCachesLive)),
});
