import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const typesAreDerivedInline = Task.make(
  "no-type-declarations rejects every type alias, interface, enum, namespace, ambient module and declare global, while inline annotations, derived types and classes stay allowed",
  ruleTest("no-type-declarations", {
    valid: [
      'import { Schema } from "effect"; const Payload = Schema.Struct({ id: Schema.String }); const read = (payload: typeof Payload.Type) => payload.id;',
      "const make = () => ({ id: 1 }); const keep = (made: ReturnType<typeof make>) => made.id;",
      "const run = (first: string) => first; const again = (value: Parameters<typeof run>[0]) => value;",
      "const LIMITS = { retries: 3 } as const; const limit = (name: keyof typeof LIMITS) => LIMITS[name];",
      "const values: ReadonlyArray<{ readonly id: number }> = [];",
      "class Store { readonly items = new Map<string, number>(); }",
      'import type { Effect } from "effect"; const value = (effect: Effect.Effect<number>) => effect;',
      "abstract class Base { abstract run(): void; stop() {} }",
      'import { Schema } from "effect"; export class Category extends Schema.Class<Category>("Category")({ name: Schema.String, children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category)) }) {}',
    ],
    invalid: [
      {
        code: "type Shape = { readonly id: number };",
        errors: [{ message: "type Shape is declared" }],
      },
      {
        code: 'export type Kind = "a" | "b";',
        errors: [{ message: "type Kind is declared" }],
      },
      {
        code: 'import { Schema } from "effect"; const Payload = Schema.Struct({}); export type Payload = typeof Payload.Type;',
        errors: [{ message: "type Payload is declared" }],
      },
      {
        code: "type Box<Content> = { readonly content: Content };",
        errors: [{ message: "type Box is declared" }],
      },
      {
        code: "interface Shape { readonly id: number }",
        errors: [{ message: "interface Shape is declared" }],
      },
      {
        code: "export interface Bag extends Map<string, string> {}",
        errors: [{ message: "interface Bag is declared" }],
      },
      {
        code: 'declare module "assets" { interface Asset { readonly url: string } }',
        errors: [
          { message: 'declare module "assets" is declared' },
          { message: "interface Asset is declared" },
        ],
      },
      {
        code: 'declare module "assets";',
        filename: "assets.d.ts",
        errors: [{ message: 'declare module "assets" is declared' }],
      },
      {
        code: "export const COUNT = 1; declare global { var count: number }",
        errors: [{ message: "declare global is declared" }],
      },
      {
        code: "export namespace Shapes { export const SIZE = 1; }",
        errors: [{ message: "namespace Shapes is declared" }],
      },
      {
        code: "enum Kind { A, B }",
        errors: [{ message: "enum Kind is declared" }],
      },
      {
        code: "export const enum Kind { A = 'a' }",
        errors: [{ message: "enum Kind is declared" }],
      },
      {
        code: "type Shape = { readonly id: number };",
        filename: "shapes.d.ts",
        errors: [{ message: "type Shape is declared" }],
      },
    ],
  }),
);

export const overloadsAreSeparateFunctions = Task.make(
  "no-overloads groups bodiless signatures and implementations by name within each container and rejects every signature that shares its name, so one signature before its implementation is rejected too, while a lone ambient signature stays allowed",
  ruleTest("no-overloads", {
    valid: [
      "function parse(text: string) { return text; }",
      "const parseText = (text: string) => text; const parseCount = (count: number) => count;",
      "declare function external(value: string): string;",
      "class Reader { read(text: string) { return text; } }",
      "abstract class Reader { abstract read(text: string): string; }",
      "declare class Reader { read(text: string): string; write(text: string): void; static read(): Reader; }",
      {
        code: "export declare class Reader { read(text: string): string; }",
        filename: "reader.d.ts",
      },
      "declare class Box { get value(): number; set value(next: number); }",
      "const read: { (text: string): string } = (text) => text;",
      "const reader: { read(text: string): string; write(text: string): void } = { read: (text) => text, write: () => {} };",
      "function outer() { function inner(text: string) { return text; } return inner; } declare function inner(count: number): number;",
      "class Box { get value() { return 1; } set value(next: number) {} }",
      'declare module "reader" { function read(text: string): string; }',
      "abstract class Reader { abstract read(text: string): string; write(text: string) { return text; } }",
    ],
    invalid: [
      {
        code: "function parse(text: string): string; function parse(input: string) { return input; }",
        errors: [{ message: "parse is overloaded" }],
      },
      {
        code: "export function parse(text: string): string; export function parse(input: string) { return input; }",
        errors: [{ message: "parse is overloaded" }],
      },
      {
        code: "export default function parse(text: string): string; export default function parse(input: string) { return input; }",
        errors: [{ message: "parse is overloaded" }],
      },
      {
        code: "export default function (text: string): string; export default function (input: string) { return input; }",
        errors: [{ message: "the default export is overloaded" }],
      },
      {
        code: "declare function parse(text: string): string; function parse(input: string) { return input; }",
        errors: [{ message: "parse is overloaded" }],
      },
      {
        code: "function outer() { function inner(text: string): string; function inner(input: string) { return input; } return inner; }",
        errors: [{ message: "inner is overloaded" }],
      },
      {
        code: "namespace Shapes { export function area(side: number): number; export function area(side: number) { return side * side; } }",
        errors: [{ message: "area is overloaded" }],
      },
      {
        code: "class Reader { read(text: string): string; read(input: string) { return input; } }",
        errors: [{ message: "read is overloaded" }],
      },
      {
        code: "class Reader { static read(text: string): Reader; static read(input: string) { return new Reader(); } read() {} }",
        errors: [{ message: "static read is overloaded" }],
      },
      {
        code: "class Reader { constructor(text: string); constructor(readonly input: string) {} }",
        errors: [{ message: "the constructor is overloaded" }],
      },
      {
        code: "function parse(text: string): string; function parse(count: number): number; function parse(input: string | number) { return input; }",
        errors: [{ message: "parse is overloaded" }, { message: "parse is overloaded" }],
      },
      {
        code: "declare function parse(text: string): string; declare function parse(count: number): number;",
        errors: [{ message: "parse is overloaded" }, { message: "parse is overloaded" }],
      },
      {
        code: "export declare function parse(text: string): string; export declare function parse(count: number): number;",
        filename: "parse.d.ts",
        errors: [{ message: "parse is overloaded" }, { message: "parse is overloaded" }],
      },
      {
        code: "class Reader { read(text: string): string; read(count: number): number; read(input: string | number) { return input; } }",
        errors: [{ message: "read is overloaded" }, { message: "read is overloaded" }],
      },
      {
        code: "declare class Reader { read(text: string): string; read(count: number): number; }",
        errors: [{ message: "read is overloaded" }, { message: "read is overloaded" }],
      },
      {
        code: "const parse: { (text: string): string; (count: number): number } = (input: never) => input;",
        errors: [
          { message: "the call signature is overloaded" },
          { message: "the call signature is overloaded" },
        ],
      },
      {
        code: "const reader: { read(text: string): string; read(count: number): number } = { read: (input: never) => input };",
        errors: [{ message: "read is overloaded" }, { message: "read is overloaded" }],
      },
      {
        code: "namespace Shapes { declare function area(side: number): number; declare function area(width: number, height: number): number; }",
        errors: [{ message: "area is overloaded" }, { message: "area is overloaded" }],
      },
    ],
  }),
);
