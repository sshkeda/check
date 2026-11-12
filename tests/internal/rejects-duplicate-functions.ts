import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Predicate } from "effect";

import {
  duplicateFunctionViolations,
  findDuplicateFunctions,
} from "../../src/lib/tasks/lib/detect-duplicate-functions/internal/find-duplicate-functions.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const printedViolations = (sources: Readonly<Record<string, string>>) =>
  duplicateFunctionViolations(Object.entries(sources).map(([path, text]) => ({ path, text }))).map(
    ({ location, message }) => `${location}: ${message}`,
  );

export const copiedNamedFunctionsAreReportedOncePerGroup = Task.make({
  name: "a named function copied exactly into src/, scripts/ or tests/ is reported once, at its first copy, with every other copy named, even when whitespace and comments differ",
  run: Effect.sync(() => {
    expect(
      printedViolations({
        "scripts/build.ts":
          'const git = (args: string[]) => run("git", args);\nexport const build = () => git([]);\n',
        "scripts/release.ts":
          'const git = (args: string[]) =>\n  run(\n    "git", // the program\n    args,\n  );\nexport const release = () => git(["tag"]);\n',
        "src/internal/a.ts": "\n\nexport function sinceOf(day: number) {\n  return day - 1;\n}\n",
        "src/internal/b.ts": "export function sinceOf(day: number) { return day - 1; }\n",
        "tests/shared/c.ts":
          'const git = function (args: string[]) { return run("git", args); };\n',
        "tests/shared/d.ts":
          'export const run = (program: string, args: string[]) => [program, ...args];\nconst git = (args: string[]) => run("git", args);\n',
      }),
    ).toEqual([
      "scripts/build.ts:1: git has exact copies in scripts/release.ts:1 and tests/shared/d.ts:2",
      "src/internal/a.ts:3: sinceOf has an exact copy in src/internal/b.ts:1",
    ]);
  }),
});

export const copiesMatchAcrossScriptTypesAndParentheses = Task.make({
  name: "a copy in a JavaScript file matches its TypeScript twin, and a function assigned in parentheses is still a named function",
  run: Effect.sync(() => {
    expect(
      printedViolations({
        "scripts/a.ts": "export const read = () => 1;\nexport const wrapped = (() => 2);\n",
        "scripts/b.js": "export const read = () => 1;\n",
        "scripts/c.mjs": "export const wrapped = (() => 2);\n",
      }),
    ).toEqual([
      "scripts/a.ts:1: read has an exact copy in scripts/b.js:1",
      "scripts/a.ts:2: wrapped has an exact copy in scripts/c.mjs:1",
    ]);
  }),
});

export const onlyExactNamedCopiesCount = Task.make({
  name: "functions with another name, other code, another quote style or another declaration form, inline callbacks, object properties, methods and bodiless declarations are not copies",
  run: Effect.sync(() => {
    expect(
      printedViolations({
        "src/internal/a.ts": [
          "export const first = (value: number) => value + 1;",
          "export const other = (value: number) => value + 2;",
          'export const quoted = () => "text";',
          "export const declared = (value: number) => value;",
          "export const handlers = { handle: (value: number) => value * 2 };",
          "export class Store { read(value: number) { return value * 3; } }",
          "export const doubled = [1].map((value) => value * 4);",
          "export declare function overloaded(value: number): number;",
          "",
        ].join("\n"),
        "src/internal/b.ts": [
          "export const second = (value: number) => value + 1;",
          "export const other = (value: number) => value + 3;",
          "export const quoted = () => 'text';",
          "export function declared(value: number) { return value; }",
          "export const handlers = { handle: (value: number) => value * 2 };",
          "export class Store { read(value: number) { return value * 3; } }",
          "export const doubled = [1].map((value) => value * 4);",
          "export declare function overloaded(value: number): number;",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  }),
});

export const copiesInsideCopiesAreReportedOnlyAtTheOutermostCopy = Task.make({
  name: "a named function inside two copies of an outer function is reported only through the outer copy, unless it also stands as a copy elsewhere",
  run: Effect.sync(() => {
    const outer =
      "export const walk = (nodes: number[]) => {\n  const visit = (node: number) => node * 2;\n  return nodes.map(visit);\n};\n";
    expect(printedViolations({ "src/internal/a.ts": outer, "src/internal/b.ts": outer })).toEqual([
      "src/internal/a.ts:1: walk has an exact copy in src/internal/b.ts:1",
    ]);
    expect(
      printedViolations({
        "src/internal/a.ts": outer,
        "src/internal/b.ts": outer,
        "src/internal/c.ts": "export const visit = (node: number) => node * 2;\n",
      }),
    ).toEqual([
      "src/internal/a.ts:1: walk has an exact copy in src/internal/b.ts:1",
      "src/internal/a.ts:2: visit has exact copies in src/internal/b.ts:2 and src/internal/c.ts:1",
    ]);
  }),
});

export const closuresOverAnEnclosingFunctionAreNotCopies = Task.make({
  name: "a named function that reads a parameter or local of a function around it is not a copy, while one that reads only its own bindings, its own name, property names and module-level bindings is",
  run: Effect.sync(() => {
    const closures = [
      "export const first = (members: string[], owner: string) => {",
      "  const ownedBy = (name: string) => members.includes(name);",
      "  const named = (name: string) => { const owner = name; return owner.length; };",
      "  const counted = (node: { owner: string }) => node.owner.length;",
      "  const walk = (depth: number): number => (depth > 0 ? walk(depth - 1) : LIMIT);",
      "  return [ownedBy(owner), named(owner), counted({ owner }), walk(1)];",
      "};",
      "",
    ].join("\n");
    expect(
      printedViolations({
        "tests/internal/a.ts": `const LIMIT = 1;\n${closures}`,
        "tests/internal/b.ts": `const LIMIT = 1;\n${closures.replace("first", "second")}`,
      }),
    ).toEqual([
      "tests/internal/a.ts:4: named has an exact copy in tests/internal/b.ts:4",
      "tests/internal/a.ts:5: counted has an exact copy in tests/internal/b.ts:5",
      "tests/internal/a.ts:6: walk has an exact copy in tests/internal/b.ts:6",
    ]);
  }),
});

const scopesFixture = (outer: string) =>
  [
    "type X = number;",
    "export const LIMIT = 1;",
    `export function ${outer}(x: number, X: string) {`,
    "  const shadowed = () => { const id = (x: number) => x; return id(x); };",
    "  if (LIMIT) { var hoisted = 1; }",
    "  const readsHoisted = () => hoisted;",
    "  const typed = (value: X) => value;",
    "  const selfNamed = () => class X { static self() { return X; } };",
    "  const usesArguments = () => arguments.length;",
    "  enum Local { A }",
    "  const readsEnum = () => Local.A;",
    "  const named = () => { enum Inner { x } return Inner.x; };",
    "  const accessorName = () => class { accessor x = 1; };",
    "  const ownThis = function () { return this; };",
    "  const capturesThis = () => this;",
    "  switch (x) { case 1: const s = 1; break; default: { const inSwitch = () => s; } }",
    "  return [shadowed, readsHoisted, typed, selfNamed, usesArguments, readsEnum, named, accessorName, ownThis, capturesThis];",
    "}",
    "",
  ].join("\n");
const tagsFixture = (outer: string) =>
  [
    `export function ${outer}(Component: () => null, div: string) {`,
    "  const render = () => <Component />;",
    "  const plain = () => <div />;",
    "  const custom = () => <my-el />;",
    "  return [render, plain, custom, div];",
    "}",
    "",
  ].join("\n");

export const eachReadIsResolvedInTheScopeWhereItIsWritten = Task.make({
  name: "a read is a capture only when its name resolves to a binding of a function around the named function: a shadowing parameter, a hoisted var, the implicit arguments and this, a let in another switch case, a local enum and a JSX component tag count, while type names, a class expression's own name, a function's own this, enum member and accessor names and intrinsic JSX tags do not",
  run: Effect.sync(() => {
    expect(
      printedViolations({
        "tests/internal/a.ts": scopesFixture("outerA"),
        "tests/internal/b.ts": scopesFixture("outerB"),
        "tests/internal/c.tsx": tagsFixture("outerC"),
        "tests/internal/d.tsx": tagsFixture("outerD"),
      }),
    ).toEqual([
      "tests/internal/a.ts:4: id has an exact copy in tests/internal/b.ts:4",
      "tests/internal/a.ts:7: typed has an exact copy in tests/internal/b.ts:7",
      "tests/internal/a.ts:8: selfNamed has an exact copy in tests/internal/b.ts:8",
      "tests/internal/a.ts:12: named has an exact copy in tests/internal/b.ts:12",
      "tests/internal/a.ts:13: accessorName has an exact copy in tests/internal/b.ts:13",
      "tests/internal/a.ts:14: ownThis has an exact copy in tests/internal/b.ts:14",
      "tests/internal/c.tsx:3: plain has an exact copy in tests/internal/d.tsx:3",
      "tests/internal/c.tsx:4: custom has an exact copy in tests/internal/d.tsx:4",
    ]);
  }),
});

export const theCheckReadsEveryOwnedScriptOfThePackage = Task.make({
  name: "the duplicate-function check reads the package's tracked and untracked scripts, skips ignored and generated files, leaves a nested package's files to that package and names the other copies from where Check runs",
  run: Effect.gen(function* () {
    const copied = "export const sinceOf = (day: number) => day - 1;\n";
    const { directory } = yield* makeProject(
      {
        "src/index.ts": "export {};\n",
        ".gitignore": "ignored/\nnode_modules/\n",
        "src/internal/a.ts": copied,
        "scripts/b.ts": copied,
        "src/internal/generated.ts": copied,
        "ignored/c.ts": copied,
        "nested/package.json": '{"name":"nested"}',
        "nested/d.ts": copied,
      },
      'lintConfig({ "src/internal/generated.ts": { allow: ["isGeneratedByATool"] } })',
    );
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    const failure = yield* findDuplicateFunctions(directory).pipe(failureAsValue);
    expect(Predicate.isTagged(failure, "DuplicateFunctions")).toBe(true);
    if (Predicate.isTagged(failure, "DuplicateFunctions")) {
      expect(failure.message).toBe(
        "scripts/b.ts:1: error DuplicateFunction: sinceOf has an exact copy in src/internal/a.ts:1",
      );
    }
    const nested = yield* findDuplicateFunctions(directory, "packages/lib").pipe(failureAsValue);
    expect(nested.message).toBe(
      "scripts/b.ts:1: error DuplicateFunction: sinceOf has an exact copy in packages/lib/src/internal/a.ts:1",
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});
