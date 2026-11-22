import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const combinator = (member: string, code: string) => ({
  code,
  errors: [{ messageId: "combinator", data: { member } }],
});

const exported = (code: string) => ({ code, errors: [{ messageId: "exported" }] });

export const promiseCombinatorsAreRejected = Task.make({
  name: "no-promise-combinators reports Promise.all, Promise.allSettled, Promise.race and Promise.any called or used as a value, by dot, string key or optional chain, on the global Promise, through window, self, globalThis or global, a constant alias or a subclass, each destructured member once, and the Promise constructor exported by default, by name or as a constant",
  run: ruleTest("no-promise-combinators", {
    valid: [],
    invalid: [
      combinator("all", "Promise.all(work);"),
      combinator("allSettled", "Promise.allSettled(work);"),
      combinator("race", "Promise.race(work);"),
      combinator("any", "Promise.any(work);"),
      combinator("all", "const joined = [work].map(Promise.all);"),
      combinator("all", "const join = Promise.all;"),
      combinator("race", 'Promise["race"](work);'),
      combinator("all", "Promise?.all(work);"),
      combinator("all", "Promise.all?.(work);"),
      combinator("all", "window.Promise.all(work);"),
      combinator("race", "self.Promise.race(work);"),
      combinator("any", "globalThis.Promise.any(work);"),
      combinator("allSettled", 'global["Promise"].allSettled(work);'),
      combinator("all", "const Native = Promise; Native.all(work);"),
      combinator("race", "const Native = window.Promise; Native.race(work);"),
      combinator("all", "class Pending extends Promise<number> {} Pending.all(work);"),
      combinator("all", "const { all } = Promise; all(work);"),
      combinator("race", "const { race: first } = window.Promise; first(work);"),
      exported("export default Promise;"),
      exported("const NativePromise = Promise; export { NativePromise };"),
      exported("export const NativePromise = Promise;"),
    ],
  }),
});

export const otherPromiseUsesAndLookalikesPass = Task.make({
  name: "no-promise-combinators passes a local object or class named Promise, a parameter named Promise, a local window, other members of the containers, Promise.resolve, Promise.reject, Promise.withResolvers, new Promise, instanceof Promise, Promise.resolve bound to Promise, Promise in a type, Effect.all, Effect.raceFirst, Stream.race, all or race on another object, and an ambient class that extends Promise",
  run: ruleTest("no-promise-combinators", {
    valid: [
      "const Promise = { all: () => 1 }; Promise.all();",
      "class Promise { static all() { return 1; } } Promise.all();",
      "const run = (Promise: { all: () => number }) => Promise.all();",
      "const window = { Promise: { all: () => 1 } }; window.Promise.all();",
      "window.fetch(url); globalThis.queueMicrotask(task);",
      "Promise.resolve(1);",
      "Promise.reject(failure);",
      "Promise.withResolvers();",
      "const pending = new Promise((resolve) => resolve(1));",
      "const isPending = value instanceof Promise;",
      "const resolve = Promise.resolve.bind(Promise);",
      "const pending: Promise<number> = later;",
      "type Constructor = typeof Promise;",
      "type Joined = ReturnType<typeof Promise.all>;",
      'import { Effect, Stream } from "effect"; Effect.all([work]); Effect.raceFirst(left, right); Stream.make(1).pipe(Stream.race(other));',
      "tasks.all(); tasks.race();",
      { code: "export declare class Pending extends Promise<number> {}", filename: "pending.d.ts" },
    ],
    invalid: [],
  }),
});

export const combinatorsReachedThroughSuperASubclassOrAHiddenNameAreRejected = Task.make({
  name: "no-promise-combinators reports a combinator reached through super in a static method, static property or static block of a Promise subclass, through a subclass or its child that does not define that static member at run time, through the inner name of a class expression, and through Promise or window when a type parameter or type alias has the same name",
  run: ruleTest("no-promise-combinators", {
    valid: [],
    invalid: [
      combinator(
        "all",
        "class Pending extends Promise<number> { static join(work: Promise<number>[]) { return super.all(work); } }",
      ),
      combinator(
        "race",
        "class Pending extends Promise<number> { static join = (work: Promise<number>[]) => super.race(work); }",
      ),
      combinator("any", "class Pending extends Promise<number> { static { super.any(work); } }"),
      combinator(
        "all",
        "class Base extends Promise<number> {} class Pending extends Base { static join(work: Promise<number>[]) { return super.all(work); } }",
      ),
      combinator(
        "all",
        "class Pending extends Promise<number> { static all(work: Promise<number>[]) { return super.all(work); } } Pending.all(work);",
      ),
      combinator(
        "all",
        "class Pending extends Promise<number> { static join() { return 1; } } Pending.all(work);",
      ),
      combinator(
        "all",
        "class Pending extends Promise<number> { static race = collect; } class Child extends Pending {} Child.all(work);",
      ),
      combinator(
        "all",
        "class Pending extends Promise<number> { declare static all: typeof collect; } Pending.all(work);",
      ),
      combinator(
        "all",
        "const Pending = class Inner extends Promise<number> { static join(work: Promise<number>[]) { return Inner.all(work); } };",
      ),
      combinator(
        "all",
        "function join<Promise>(work: Iterable<Promise>) { return Promise.all(work); }",
      ),
      combinator(
        "all",
        "function join<window>(work: Iterable<number>) { return window.Promise.all(work); }",
      ),
      combinator("race", "type Promise = number; Promise.race(work);"),
    ],
  }),
});

export const ownStaticMembersAndInstanceSuperPass = Task.make({
  name: "no-promise-combinators passes super in an instance method of a Promise subclass, a static method, static property or static accessor that a Promise subclass defines for itself, the same member reached through a child class or through super from a child, and that member destructured from the subclass",
  run: ruleTest("no-promise-combinators", {
    valid: [
      "class Pending extends Promise<number> { join(work: Promise<number>[]) { return super.all(work); } }",
      "class Pending extends Promise<number> { static all(work: Promise<number>[]) { return collect(work); } } Pending.all(work);",
      "class Pending extends Promise<number> { static race = (work: Promise<number>[]) => collect(work); } Pending.race(work);",
      "class Pending extends Promise<number> { static get any() { return collect; } } Pending.any(work);",
      'class Pending extends Promise<number> { static ["allSettled"] = collect; } Pending.allSettled(work);',
      "class Pending extends Promise<number> { static all(work: Promise<number>[]) { return collect(work); } } class Child extends Pending {} Child.all(work);",
      "class Base extends Promise<number> { static all(work: Promise<number>[]) { return collect(work); } } class Pending extends Base { static join(work: Promise<number>[]) { return super.all(work); } }",
      "class Pending extends Promise<number> { static all = collect; } const { all } = Pending; all(work);",
    ],
    invalid: [],
  }),
});

export const eachExportedBindingIsResolvedByItself = Task.make({
  name: "no-promise-combinators reports a destructured export that binds the Promise constructor, reports a destructured and exported combinator once as a combinator, and passes a destructured export of another member and a type-only export of a constant alias",
  run: ruleTest("no-promise-combinators", {
    valid: [
      "export const { name: promiseName } = Promise;",
      "const NativePromise = Promise; export type { NativePromise };",
      "const NativePromise = Promise; export { type NativePromise };",
    ],
    invalid: [
      exported("export const { Promise: NativePromise } = window;"),
      combinator("all", "export const { all } = Promise;"),
    ],
  }),
});

export const destructuringOutsideADeclarationIsRejected = Task.make({
  name: "no-promise-combinators reports a combinator destructured from Promise once in a default parameter, in an assignment and with a default value",
  run: ruleTest("no-promise-combinators", {
    valid: [],
    invalid: [
      combinator("all", "function join({ all } = Promise) { return all.call(Promise, []); }"),
      combinator("all", "let join; ({ all: join } = Promise);"),
      combinator("race", "const { race = collect } = Promise; race(work);"),
    ],
  }),
});

export const combinatorsReachedThroughAConstantKeyOrANestedPatternAreRejected = Task.make({
  name: "no-promise-combinators reports a combinator destructured by a constant computed key or from Promise nested in a container pattern, once even with a default, including a default subclass that defines that member, and through a subclass whose own statics have a symbol key, also through a container, or a constant key that folds to another name",
  run: ruleTest("no-promise-combinators", {
    valid: [],
    invalid: [
      combinator(
        "all",
        'const key = "all"; const { [key]: join } = Promise; join.call(Promise, [1]);',
      ),
      combinator("all", "const { Promise: { all: join } } = globalThis;"),
      combinator("race", "const { Promise: { race } = {} } = window;"),
      combinator("all", "const { Promise: { all } = Promise } = window;"),
      combinator(
        "all",
        "class Pending extends Promise<number> { static get [Symbol.species]() { return Promise; } } Pending.all(work);",
      ),
      combinator(
        "all",
        "class Pending extends Promise<number> { static get [globalThis.Symbol.species]() { return Promise; } } Pending.all(work);",
      ),
      combinator(
        "all",
        `const metadata = "metadata"; class Pending extends Promise<number> { static [\`\${metadata}Label\`]() { return "pending"; } } Pending.all([1]);`,
      ),
      combinator(
        "race",
        'class Pending extends Promise<number> { static ["ra" + "ce" + 1]() { return 1; } } Pending.race([1]);',
      ),
      combinator(
        "all",
        'class Custom extends Promise<number> { static all(): never { throw new Error("unsupported"); } } const { Promise: { all } = Custom } = globalThis;',
      ),
    ],
  }),
});

export const aSubclassWithAnUnresolvedStaticKeyPasses = Task.make({
  name: "no-promise-combinators passes a combinator called on a Promise subclass that defines it under a constant key that folds to its name, or defines a static member whose computed key it cannot resolve, since that member may be the combinator",
  run: ruleTest("no-promise-combinators", {
    valid: [
      'class Pending extends Promise<number> { static ["ra" + "ce"]() { return 1; } } Pending.race([1]);',
      `const prefix = "a"; class Pending extends Promise<number> { static [\`\${prefix}ll\`] = collect; } Pending.all(work);`,
      "class Pending extends Promise<number> { static [name] = collect; } class Child extends Pending {} Child.all(work);",
    ],
    invalid: [],
  }),
});
