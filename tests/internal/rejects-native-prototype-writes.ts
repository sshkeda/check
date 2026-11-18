import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const writeTo = (name: string, code: string) => ({
  code,
  errors: [{ messageId: "nativePrototype", data: { name } }],
});

export const nativePrototypesStayAsTheyAre = Task.make({
  name: "no-native-prototype-writes reports a write to a built-in prototype through assignment, delete, update, Object and Reflect calls, constant aliases, destructuring, static keys and global containers",
  run: ruleTest("no-native-prototype-writes", {
    valid: [
      "Object.assign({}, source);",
      "Object.assign(user, source);",
      'Object.defineProperty(user, "last", descriptor);',
      'Reflect.defineProperty(target, "last", { value: 1 });',
      "Reflect.set(user, key, value);",
      "class Mine {} Mine.prototype.last = 1;",
      "class Mine {} Object.assign(Mine.prototype, source);",
      "class Mine {} const target = Mine.prototype; target.last = 1;",
      "const target = Array.prototype;",
      "const read = Array.prototype.map;",
      "Object.assign({}, Array.prototype);",
      "Object.setPrototypeOf(user, Array.prototype);",
      "Object.assign(Array.prototype);",
      'Object.defineProperty({ source: Array.prototype }, "last", descriptor);',
      'Object.defineProperty(targetOf(Array.prototype), "last", descriptor);',
      'Reflect.set(Array.prototype, "last", 1, {});',
      'Reflect.set(Array.prototype, "last", ...rest);',
      "class Array {} Array.prototype.last = 1;",
      "const run = (Object) => Object.assign(Array.prototype, source);",
      'const Reflect = { set: () => true }; Reflect.set(Array.prototype, "last", 1);',
      "let target = Array.prototype; target = user; target.last = 1;",
      "const { prototype: target = user } = Array; target.last = 1;",
      "Array[key].last = 1;",
      "Array.prototype.map.tag = 1;",
      "Array.last = 1;",
      'Object.defineProperty(Error, "prepareStackTrace", descriptor);',
      "Array.prototype.push(1);",
      "const first = Array.prototype.at;",
    ],
    invalid: [
      ...[
        "Array.prototype.last = 1;",
        'Array["prototype"]["last"] = 1;',
        "Array.prototype[Symbol.iterator] = replacement;",
        "Array.prototype.last += 1;",
        "Array.prototype.count++;",
        "delete Array.prototype.last;",
        "[Array.prototype.last] = source;",
        "Array.prototype = value;",
        "(Array.prototype as never).last = 1;",
        "Object.assign(Array.prototype, { last() {} });",
        'Object.defineProperty(Array.prototype, "last", { value: 1 });',
        "Object.defineProperties(Array.prototype, descriptors);",
        "Object.setPrototypeOf(Array.prototype, other);",
        'Reflect.defineProperty(Array.prototype, "last", { value: 1 });',
        'Reflect.set(Array.prototype, "last", 1);',
        'Reflect.set({}, "last", 1, Array.prototype);',
        'Reflect.deleteProperty(Array.prototype, "at");',
        "Reflect.setPrototypeOf(Array.prototype, other);",
        "Object?.assign(Array.prototype, source);",
        "const target = Array.prototype; target.last = 1;",
        "const target = Array.prototype; const next = target; next.last = 1;",
        "const List = Array; List.prototype.last = 1;",
        "const { prototype: target } = Array; target.last = 1;",
        "const assign = Object.assign; assign(Array.prototype, source);",
        "const { assign: copy } = Object; copy(Array.prototype, source);",
        "const { defineProperty: define } = Reflect; define(Array.prototype, key, descriptor);",
        'const key = "prototype"; Array[key].last = 1;',
        "globalThis.Array.prototype.last = 1;",
        "window.Array.prototype.last = 1;",
        "globalThis.Object.assign(Array.prototype, source);",
        'Object.defineProperty(Array.prototype, "last", ...descriptors);',
        "Object.assign(Array.prototype, ...sources);",
        "delete Array.prototype?.last;",
      ].map((code) => writeTo("Array", code)),
      ...["Object.prototype.last = 1;", "Array.prototype.__proto__.last = 1;"].map((code) =>
        writeTo("Object", code),
      ),
      writeTo("Promise", "Promise.prototype.last = 1;"),
      writeTo("DisposableStack", "DisposableStack.prototype.trace = 1;"),
      writeTo("AsyncDisposableStack", "AsyncDisposableStack.prototype.trace = 1;"),
      writeTo("Error", "TypeError.prototype.__proto__.code = 1;"),
      writeTo("String", "Object.assign(String.prototype, { shout() {} });"),
      {
        code: "const target = Array.prototype; target.first = 1; target.last = 1;",
        errors: [
          { messageId: "nativePrototype", data: { name: "Array" } },
          { messageId: "nativePrototype", data: { name: "Array" } },
        ],
      },
    ],
  }),
});
