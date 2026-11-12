import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const INDEX = "src/store/index.ts";

const IMPORTS = [
  'import { Layer } from "effect";',
  'import { make, plugin, ready, Reader, run, Store, Writer } from "./internal/make.ts";',
  "",
].join("\n");

const holds = (code: string, kinds: readonly string[], filename = INDEX) => ({
  code: `${IMPORTS}${code}`,
  filename,
  errors: kinds.map((kind) => ({ message: `index file holds ${kind}` })),
});

const outsideAnExport = (code: string, kind: string) => ({
  code: `${IMPORTS}${code}`,
  filename: INDEX,
  errors: [{ message: `index file holds ${kind} outside an export statement` }],
});

const readsGlobal = (code: string, name: string) => ({
  code: `${IMPORTS}${code}`,
  filename: INDEX,
  errors: [{ message: `index file reads the global ${name}` }],
});

export const indexFilesHoldOnlyWiring = Task.make({
  name: "no-index-logic lets index.ts and index.tsx hold only imports, import = and export import = aliases, re-exports, export as namespace, type declarations, export const declarations, export default, export = and expression statements built from the file's own bindings, undefined, member reads, calls, new, literals, negative number and bigint literals, templates, arrays, objects, spreads and TypeScript-only wrappers, so an index.ts run directly starts with a top-level call, and reports every other statement, if (import.meta.main) included, let, var and using declarations, every function, method, getter, setter, class, operator and other expression, each namespace, each declaration outside an export statement, even one a later export { } lists or a declare function, and each read of a global",
  run: ruleTest("no-index-logic", {
    valid: [
      {
        code: [
          IMPORTS,
          'export { Reader as default } from "./internal/reader.ts";',
          'export type { Shape } from "./internal/shape.ts";',
          "export { plugin };",
          "export type Size = number;",
          "export const LIVE = Layer.mergeAll(Reader, Writer);",
          'export const NAMES = ["reader", "writer"] as const;',
          "export const SECOND = LIVE.pipe(Layer.provide(Reader));",
          "export const STORE = new Store(make(1, -1, -0n, 2.5, true, false, null, undefined, /a/u));",
          "export const CONFIG = {",
          '  name: "store",',
          "  sizes: [1, , ...Reader.sizes],",
          "  nested: { on: true },",
          `  text: \`size \${Reader.size}\`,`,
          "  ...Writer,",
          "  [Reader.key]: Writer[Reader.key],",
          "  plugin,",
          "} satisfies object;",
          "export const TYPED: number = make<number>(1)!;",
          "export const WRAPPED = (<number>make(Reader));",
          "export declare const DECLARED: number;",
          "run(LIVE);",
          "",
        ].join("\n"),
        filename: INDEX,
      },
      { code: `${IMPORTS}export default plugin;`, filename: INDEX },
      { code: 'export * from "./internal/make.ts";', filename: INDEX },
      { code: "export default interface Shape {\n  size: number;\n}", filename: INDEX },
      { code: `${IMPORTS}export const A = make(1),\n  B = make(2);`, filename: INDEX },
      {
        code: 'import path = require("node:path");\nexport import url = require("node:url");\nexport as namespace Store;',
        filename: INDEX,
      },
      { code: `${IMPORTS}export = make(Reader);`, filename: INDEX },
      { code: `${IMPORTS}export default make(Reader);`, filename: "src/web/index.tsx" },
      {
        code: `${IMPORTS}run(make(Reader).pipe(Layer.provide(Writer)));`,
        filename: "src/cli/index.ts",
      },
      {
        code: "export const run = () => (ready ? 1 : 2);\nfor (const item of items) {}",
        filename: "src/store/internal/run-the-store.ts",
      },
      { code: "export const run = () => 1;", filename: "src/store/index.js" },
    ],
    invalid: [
      holds("export const read = () => 1;", ["an arrow function expression"]),
      holds("export function read() {\n  return 1;\n}", ["a function declaration"]),
      holds("export default function () {}", ["a function declaration"]),
      holds("export default () => Reader;", ["an arrow function expression"]),
      holds("export const PROGRAM = Layer.effect(Reader, function* () {});", [
        "a function expression",
      ]),
      holds(
        "export const STORE = { read() {\n  return 1;\n}, get size() {\n  return 1;\n}, set size(value: number) {} };",
        ["a method", "a getter", "a setter"],
      ),
      holds("export let SIZE = 1;\nexport var COUNT = 2;", [
        "a let declaration",
        "a var declaration",
      ]),
      holds("export = () => Reader;", ["an arrow function expression"]),
      holds("export class Kept {}", ["a class declaration"]),
      holds("export const KEPT = class {};", ["a class expression"]),
      holds("export const PICKED = ready ? Reader : Writer;", ["a conditional expression"]),
      holds("export const PICKED = Reader ?? Writer;", ["a logical expression"]),
      holds("export const SIZE = Reader.size + 1;", ["a binary expression"]),
      holds("export const SIZE = -Reader.size;", ["a unary expression"]),
      holds("export const SIZE = Reader?.size;", ["a chain expression"]),
      holds("export const TAGGED = make`size`;", ["a tagged template expression"]),
      holds("export const LOADED = await make(1);", ["an await expression"]),
      holds('export const LOADED = import("./internal/make.ts");', ["an import expression"]),
      holds("export const NESTED = make(() => 1, [ready ? 1 : 2], { size: Reader.size * 2 });", [
        "an arrow function expression",
        "a conditional expression",
        "a binary expression",
      ]),
      holds("Reader.size = 1;", ["an assignment expression"]),
      holds("export const { size } = Reader;", ["an object pattern"]),
      holds("export enum Mode {\n  Read,\n}", ["a TS enum declaration"]),
      holds("export const VIEW = <main />;", ["a JSX element"], "src/web/index.tsx"),
      holds("export const HERE = import.meta.url;", ["a meta property"]),
      holds("for (const item of Reader.items) {\n  run(item);\n}", ["a for of statement"]),
      holds("while (ready) {}", ["a while statement"]),
      holds("switch (ready) {\n}", ["a switch statement"]),
      holds("try {\n  run(Reader);\n} catch {}", ["a try statement"]),
      holds("{\n  run(Reader);\n}", ["a block statement"]),
      holds("if (ready) {\n  run(Reader);\n}", ["an if statement"]),
      holds("if (import.meta.main) {\n  run(Reader);\n}", ["an if statement"]),
      holds("if (import.meta.main) run(Reader);", ["an if statement"]),
      outsideAnExport(
        "const local = make(1);\nexport const LOCAL = local;",
        "a variable declaration",
      ),
      outsideAnExport("const local = make(1);\nexport { local };", "a variable declaration"),
      outsideAnExport("using held = make(1);\nexport { held };", "a variable declaration"),
      outsideAnExport("type Local = number;", "a TS type alias declaration"),
      outsideAnExport("function local() {}", "a function declaration"),
      outsideAnExport("declare function local(): void;", "a TS declare function"),
      holds("export namespace Store {}", ["a namespace declaration"]),
      outsideAnExport("namespace Local {}", "a namespace declaration"),
      outsideAnExport('declare module "x" {}', "a module declaration"),
      outsideAnExport("declare global {}", "a global declaration"),
      readsGlobal("export const ARGUMENTS = process.argv;", "process"),
      readsGlobal("run(console);", "console"),
    ],
  }),
});
