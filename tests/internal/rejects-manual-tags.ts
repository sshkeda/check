import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const rejectsHandwrittenTagObjects = Task.make(
  "no-manual-tag flags hand-written _tag objects",
  ruleTest("no-manual-tag", {
    valid: [
      "const ok = restored._tag === 'Success';",
      "switch (event._tag) { default: break; }",
      "const want = Want.make({ id, name });",
      "const tagged = { tag: 'Want' };",
      "type Want = { readonly _tag: 'Want' };",
      "const matched = Match.when({ _tag: 'Want' }, (want) => want.id);",
      "const refined = Match.not({ _tag: 'Done' }, (event) => event);",
      "import { PlatformError } from 'effect'; PlatformError.systemError({ _tag: 'NotFound', module: 'ChildProcess', method: 'spawn' });",
      "import * as Platform from 'effect/PlatformError'; Platform.systemError({ _tag: 'Unknown', module: 'FileSystem', method: 'open' });",
      "import { systemError as fail } from 'effect/PlatformError'; fail({ _tag: 'NotFound', module: 'FileSystem', method: 'open' });",
      "import * as Library from 'effect'; Library.PlatformError.systemError({ _tag: 'NotFound', module: 'Path', method: 'join' });",
    ],
    invalid: [
      { code: "emit({ _tag: 'Want', id, name });", errors: [{ messageId: "construction" }] },
      { code: "const done = { '_tag': 'Done' };", errors: [{ messageId: "construction" }] },
      { code: "const done = { ['_tag']: 'Done' };", errors: [{ messageId: "construction" }] },
      {
        code: "const nested = { inner: { _tag: 'Inner' } };",
        errors: [{ messageId: "construction" }],
      },
      {
        code: "const systemError = (options) => options; systemError({ _tag: 'NotFound', module: 'FileSystem', method: 'open' });",
        errors: [{ messageId: "construction" }],
      },
      {
        code: "import { PlatformError } from 'other'; PlatformError.systemError({ _tag: 'NotFound' });",
        errors: [{ messageId: "construction" }],
      },
      {
        code: "import { PlatformError } from 'effect'; PlatformError.systemError({ module: 'FileSystem', cause: { _tag: 'Nested' } });",
        errors: [{ messageId: "construction" }],
      },
      {
        code: "import { PlatformError } from 'effect'; PlatformError.badArgument({ _tag: 'NotFound', module: 'FileSystem', method: 'open' });",
        errors: [{ messageId: "construction" }],
      },
      {
        code: "import { PlatformError } from 'effect'; const options = { _tag: 'NotFound', module: 'FileSystem', method: 'open' }; PlatformError.systemError(options);",
        errors: [{ messageId: "construction" }],
      },
    ],
  }),
);

export const rejectsTagComparisons = Task.make(
  "no-tag-branching flags comparisons on _tag, read through optional chaining too",
  ruleTest("no-tag-branching", {
    valid: [
      "const ok = Exit.isSuccess(restored);",
      "const same = event.tag === 'Want';",
      "const tag = event._tag;",
    ],
    invalid: [
      { code: "const ok = restored._tag === 'Success';", errors: [{ messageId: "comparison" }] },
      { code: "const ok = 'Success' !== restored._tag;", errors: [{ messageId: "comparison" }] },
      { code: "const ok = restored['_tag'] == 'Success';", errors: [{ messageId: "comparison" }] },
      { code: "const ok = restored?._tag === 'Success';", errors: [{ messageId: "comparison" }] },
      {
        code: "const ok = restored?.['_tag'] !== 'Success';",
        errors: [{ messageId: "comparison" }],
      },
    ],
  }),
);

export const rejectsTagSwitches = Task.make(
  "no-tag-branching flags switches on _tag, read through optional chaining too",
  ruleTest("no-tag-branching", {
    valid: ["switch (event.kind) { case 'a': break; }"],
    invalid: [
      {
        code: "switch (event._tag) { case 'Want': break; case 'Done': break; }",
        errors: [{ messageId: "switch" }],
      },
      {
        code: "switch (event?._tag) { case 'Want': break; case 'Done': break; }",
        errors: [{ messageId: "switch" }],
      },
    ],
  }),
);

export const recommendsCatchTagForTaggedErrors = Task.make(
  "no-tag-branching points _tag branching inside Effect.catch at catchTag",
  ruleTest("no-tag-branching", {
    valid: [
      "const handled = program.pipe(Effect.catchTag('Failed', () => Effect.void));",
      "const handled = program.pipe(Effect.catch(() => Effect.void));",
    ],
    invalid: [
      {
        code: "const handled = program.pipe(Effect.catch((error) => error._tag === 'Failed' ? Effect.void : Effect.fail(error)));",
        errors: [{ messageId: "catchTag" }],
      },
      {
        code: "const handled = Effect.catchCause(program, (error) => { switch (error._tag) { default: return Effect.void; } });",
        errors: [{ messageId: "catchTag" }],
      },
      {
        code: "const handled = program.pipe(Effect.mapError((error) => error._tag === 'Failed'));",
        errors: [{ messageId: "comparison" }],
      },
    ],
  }),
);

export const rejectsTagComparisonCalls = Task.make(
  "no-tag-branching flags _tag compared with Object.is or looked up with includes",
  ruleTest("no-tag-branching", {
    valid: [
      "const same = Object.is(left, right);",
      "const listed = KINDS.includes(event.kind);",
      "const Object = { is: (left, right) => left }; const same = Object.is(event._tag, 'Want');",
      "const read = [event._tag].map(String);",
    ],
    invalid: [
      "const same = Object.is(event._tag, 'Want');",
      "const same = Object.is('Want', event['_tag']);",
      "const listed = ['Want', 'Done'].includes(event._tag);",
      "const listed = TAGS.includes(event._tag);",
    ].map((code) => ({ code, errors: [{ messageId: "comparison" }] })),
  }),
);

export const rejectsBranchingOnDestructuredTags = Task.make(
  "no-tag-branching flags comparisons and switches on a _tag destructured into a binding, while other destructured names and reassigned bindings pass",
  ruleTest("no-tag-branching", {
    valid: [
      "const { kind } = event; const ok = kind === 'Want';",
      "let { _tag } = event; _tag = other; const ok = _tag === 'Want';",
      "const read = ({ _tag }) => describe(_tag);",
      "const _tag = event.kind; const ok = _tag === 'Want';",
    ],
    invalid: [
      {
        code: "const { _tag } = event; const ok = _tag === 'Want';",
        errors: [{ messageId: "comparison" }],
      },
      {
        code: "const { _tag: tag } = event; const ok = 'Want' !== tag;",
        errors: [{ messageId: "comparison" }],
      },
      {
        code: "const isWant = ({ _tag }) => _tag === 'Want';",
        errors: [{ messageId: "comparison" }],
      },
      {
        code: "const { _tag: tag = 'Idle' } = event; const ok = tag === 'Want';",
        errors: [{ messageId: "comparison" }],
      },
      {
        code: "const { ['_tag']: tag } = event; switch (tag) { case 'Want': break; }",
        errors: [{ messageId: "switch" }],
      },
      {
        code: "const { _tag } = event; const same = Object.is(_tag, 'Want');",
        errors: [{ messageId: "comparison" }],
      },
      {
        code: "const { _tag: tag } = event; const listed = TAGS.includes(tag);",
        errors: [{ messageId: "comparison" }],
      },
      {
        code: "const handled = Effect.catch(program, ({ _tag }) => _tag === 'Failed' ? Effect.void : Effect.die(_tag));",
        errors: [{ messageId: "catchTag" }],
      },
    ],
  }),
);
