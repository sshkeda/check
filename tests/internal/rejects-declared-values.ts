import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const DECLARED_VALUES = [
  'import type { Predicate } from "effect"; export declare const isPort: Predicate.Refinement<unknown, 80>;',
  "declare let count: number;",
  "declare var count: number;",
  "export declare function isPort(value: unknown): boolean;",
  "export declare class Port {}",
  "export default 1; declare global { var count: number }",
  'declare module "ports" { export const PORT: 80; }',
  'declare module "ports" { export function isPort(value: unknown): boolean; }',
  "declare namespace Ports { const PORT: 80; }",
  "export class Port { declare public readonly value: 80; }",
  "export class Port { declare private readonly brand: 80; }",
  'export class Port { declare readonly ["value"]: 80; }',
  "export declare const isText: (value: number | string) => value is string;",
] as const;

export const declaredValuesAreRefused = Task.make(
  "no-declared-values refuses a const, let, var, function, class or class field declared with declare, a class field asserted with !, or anything inside a declare global, module or namespace block, and every value in a declaration file, while implemented values and fields, overload-free functions and type-only declarations are left alone",
  ruleTest("no-declared-values", {
    valid: [
      "export const PORT = 80;",
      "export function isPort(value: number) { return value === 80; }",
      "export class Port { private readonly brand: 80 | undefined = undefined; }",
      'declare module "assets";',
      { code: "export {};", filename: "globals.d.ts" },
    ],
    invalid: [
      {
        code: DECLARED_VALUES[0],
        errors: [{ message: "isPort is declared without an implementation" }],
      },
      ...DECLARED_VALUES.slice(1).map((code) => ({
        code,
        errors: [{ messageId: "declaredValue" }],
      })),
      {
        code: "export class Served<Success> { declare private readonly servedValue: Success; }",
        errors: [{ message: "servedValue is declared without an implementation" }],
      },
      {
        code: "export class Store { public readonly size!: number; }",
        errors: [{ message: "size is declared without an implementation" }],
      },
      {
        code: "export const PORT: 80;",
        filename: "ports.d.ts",
        errors: [{ message: "PORT is declared without an implementation" }],
      },
      {
        code: "export function isPort(value: unknown): boolean;",
        filename: "ports.d.mts",
        errors: [{ messageId: "declaredValue" }],
      },
    ],
  }),
);
