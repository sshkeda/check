import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Array as Arrays, flow } from "effect";

import { findInferrableAnnotations } from "../../src/lib/tasks/lib/detect-inferrable-annotations/internal/find-inferrable-annotations.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const HIDDEN_BOX = `interface HiddenBox { readonly size: number }
export type Box = HiddenBox;
export const makeBox = (): HiddenBox => ({ size: 1 });
`;

const violations = (source: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.symlink(path.resolve("node_modules"), path.join(directory, "node_modules"));
    yield* fileSystem.writeFileString(
      path.join(directory, "tsconfig.json"),
      yield* encodeJson({
        compilerOptions: {
          strict: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["*.ts"],
      }),
    );
    yield* fileSystem.writeFileString(path.join(directory, "box.ts"), HIDDEN_BOX);
    yield* fileSystem.writeFileString(path.join(directory, "source.ts"), source);
    return yield* findInferrableAnnotations(
      path.join(directory, "tsconfig.json"),
      openTypeScriptProjects(path.join(directory, "tsconfig.json")),
    ).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("InferrableTypeAnnotations", (failure) =>
        Effect.succeed(taggedViolations(failure.violations)),
      ),
    );
  }).pipe(Effect.scoped);

export const annotationsMatchingTheInferredTypeAreReported = Task.make(
  "annotations on constants and callback returns that TypeScript infers identically without an error are reported",
  Effect.gen(function* () {
    expect(
      yield* violations(`const total: number = [1, 2].length;
export const entries: Map<string, number> = new Map([["a", 1]]);
export const doubled = [1, 2].map((value): number => value * 2);
export const labels = [1, 2].map(function (value): string { return String(value); });
export const sizes = [total, entries.size, doubled.length, labels.length];
export const flags: Set<boolean> = new Set([true]);
export const ones = [1, 2].map((): number => 1);
export const counts = [1, 2].map((value): number => { const doubled = value * 2; return doubled; });
enum Level { Low, High }
export const levels: Set<Level> = new Set([Level.Low]);
`),
    ).toEqual([
      `source.ts:1:14: error InferrableTypeAnnotation: total has a type annotation TypeScript can infer`,
      `source.ts:2:23: error InferrableTypeAnnotation: entries has a type annotation TypeScript can infer`,
      `source.ts:3:44: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
      `source.ts:4:52: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
      `source.ts:6:21: error InferrableTypeAnnotation: flags has a type annotation TypeScript can infer`,
      `source.ts:7:36: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
      `source.ts:8:43: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
      `source.ts:10:22: error InferrableTypeAnnotation: levels has a type annotation TypeScript can infer`,
    ]);
  }),
);

export const valuesEndingInAnEmptyArrayAreJudgedWithoutTheirAnnotation = Task.make(
  "an annotated value that can end in an empty array literal, through a conditional, a comma, parentheses, ! or satisfies, gets the verdict of the stripped program",
  Effect.gen(function* () {
    expect(
      yield* violations(`declare const b: boolean;
export const pick: [] = b ? [] : [];
export const wrapped: [] = (b ? [] : []);
export const frozen: readonly [] = b ? [] : [];
export const last: [] = (0, []);
export const asserted: [] = (b ? [] : [])!;
export const nested: [] = b ? (b ? [] : []) : [];
export const checked: [] = (b ? [] : []) satisfies [];
export const viaArrow = [1].map((): [] => (b ? [] : []));
export const viaBlock = [1].map((): [] => { return b ? [] : []; });
export const viaComma = [1].map((): [] => (0, []));
`),
    ).toEqual([
      `source.ts:8:23: error InferrableTypeAnnotation: checked has a type annotation TypeScript can infer`,
    ]);
  }),
);

export const callbacksReturningAnEmptyArrayBranchAreReported = Task.make(
  "a callback whose returned value can be an empty array literal is reported when removing its never[] | [string, ...string[]] annotation keeps that type",
  Effect.gen(function* () {
    expect(
      yield* violations(`declare const results: ReadonlyArray<{ readonly failed: boolean; readonly failure: [string, ...string[]] }>;
export const failures = results.flatMap((result): never[] | [string, ...string[]] =>
  result.failed ? result.failure : [],
);
`),
    ).toEqual([
      `source.ts:2:51: error InferrableTypeAnnotation: the callback passed to flatMap has a return type annotation TypeScript can infer`,
    ]);
  }),
);

export const neighboursOfACallbackReturningAnyAreReported = Task.make(
  "a callback that returns any keeps its annotation, and a callback in the same declaration whose annotation can be removed is still reported",
  Effect.gen(function* () {
    expect(
      yield* violations(`declare function g<T>(f: () => T): T;
declare const text: string;
declare const texts: string[];
export const pair = [g((): number => JSON.parse(text)), g((): number => 1)];
export const record = { parsed: [text].map((value): number => JSON.parse(value)), next: [1].map((value): number => value + 1) };
export const chained = texts.map((value): number => JSON.parse(value)).concat([1].map((value): number => value));
export const Holder = class { parsed = [text].map((value): number => JSON.parse(value)); next = [1].map((value): number => value); };
`),
    ).toEqual([
      `source.ts:4:63: error InferrableTypeAnnotation: the callback passed to g has a return type annotation TypeScript can infer`,
      `source.ts:5:106: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
      `source.ts:6:96: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
      `source.ts:7:114: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
    ]);
  }),
);

export const annotationsTypeScriptNeedsPass = Task.make(
  "widening annotations and annotations whose removal adds an error or an any pass",
  Effect.gen(function* () {
    expect(
      yield* violations(`import { makeBox, type Box } from "./box.ts";
export const measured: number = [1].map(() => measured).length;
export const depths = [3].map(function depth(value): number { return value > 0 ? depth(value - 1) : 0; });
export const box: Box = makeBox();
const names: string[] = [];
export const listNames = () => names;
export const lookup: Map<string, number> = new Map();
type Shape = { readonly kind: "circle" } | { readonly kind: "square" };
const describe = (shape: Shape) => shape.kind;
const shapes: Array<Shape> = [{ kind: "circle" }];
export const descriptions = shapes.map(describe);
const severities: Readonly<Record<string, "error" | "off">> = Object.fromEntries(
  ["a"].map((rule): [string, "error" | "off"] => [rule, "error"]),
);
export const severity = severities["a"];
type Status = "idle" | "running";
export const status: Status = "idle";
export const REPLACEMENTS: ReadonlyMap<string, string> = new Map([["a", "b"]]);
export const pairs = ["a"].map((name): [string, "error"] => [name, "error"]);
const readLabel = () => "label";
export const LABEL: string | number = readLabel();
export const labelText = String(LABEL);
export const none: [] = [];
`),
    ).toEqual([]);
  }),
);

export const annotationsOutsideTheRulePass = Task.make(
  "let, declare, parameters, type predicates, filled literals left to no-loose-literal-constants and primitive literals left to no-inferrable-types pass",
  Effect.gen(function* () {
    expect(
      yield* violations(`let count: number = [1].length;
declare const VERSION: string;
export const greeting: string = \`version \${VERSION}\`;
export const ready: boolean = !count;
export const read = (value: string): string => value;
export const numbers = [1, "a"].filter((value): value is number => typeof value === "number");
export const LIMITS: Readonly<Record<string, number>> = { retries: 3 };
count += numbers.length + read(greeting).length + Number(ready);
`),
    ).toEqual([]);
  }),
);

export const onlyARealAnyKeepsAnAnnotation = Task.make(
  "a property named any and the string literal any do not keep an annotation, a real any does",
  Effect.gen(function* () {
    expect(
      yield* violations(`export const counters = [1].map((value): { any: number } => ({ any: value }));
const pickMode = (loose: boolean) => (loose ? "any" : "none");
export const modes = [true].map((loose): "any" | "none" => pickMode(loose));
export const parsed = ["1"].map((text): number => JSON.parse(text));
export const loose = [1].map((value): Array<number> => JSON.parse(String(value)));
`),
    ).toEqual([
      `source.ts:1:42: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
      `source.ts:3:42: error InferrableTypeAnnotation: the callback passed to map has a return type annotation TypeScript can infer`,
    ]);
  }),
);
