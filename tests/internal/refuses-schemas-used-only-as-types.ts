import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Predicate } from "effect";
import type { Schema } from "effect";

import { findDeclaredUseViolations } from "../../src/lib/tasks/lib/check-uses-by-their-declarations/internal/find-declared-use-violations.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const PREAMBLE =
  'import { Schema } from "effect";\ndeclare const inspect: (value: unknown) => void;\n';

const typeOnlySchemas = (
  sources: Readonly<Record<string, string>>,
  projectFields: Readonly<Record<string, Schema.Json>> = {},
) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      Object.fromEntries(
        Object.entries(sources).map(
          ([name, code]) => [name, name.endsWith(".ts") ? `${PREAMBLE}${code}\n` : code] as const,
        ),
      ),
      "lintConfig({})",
      projectFields,
    );
    return yield* findDeclaredUseViolations(
      tsconfigFile,
      openTypeScriptProjects(tsconfigFile),
    ).pipe(
      Effect.as(new Array<string>()),
      Effect.catchTag("DeclaredUsesRefused", (failure) =>
        Effect.succeed(
          failure.violations
            .filter((violation) => Predicate.isTagged(violation, "SchemaUsedOnlyAsType"))
            .map((violation) => `${violation.location} ${violation.message}`)
            .toSorted(),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const typeOnly = (location: string, name: string) =>
  `${location} ${name} is a schema used only as a type`;

const typeReadSchema = (name: string) =>
  `export const ${name} = Schema.Struct({ id: Schema.String });
export const show${name} = (value: typeof ${name}.Type) => value.id;`;

export const typeOnlyUseIsReported = Task.make(
  "a schema read only through typeof X.Type, typeof X.Encoded, typeof X or typeof import(...).X, in its own file or through an import, is reported",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/entry.ts": `export const ENTRY = Schema.Struct({ log: Schema.String });
export const describe = (entry: typeof ENTRY.Type) => entry.log;`,
        "src/encoded.ts": `const ENCODED = Schema.NumberFromString;
export const show = (encoded: typeof ENCODED.Encoded) => encoded;`,
        "src/whole.ts": `import { ENTRY } from "./entry.ts";
const WHOLE = Schema.Array(Schema.String).pipe(Schema.brand("Whole"));
export const keep = (whole: typeof WHOLE, entry: typeof ENTRY.Type) => [whole, entry];`,
        "src/imported.ts": "export const IMPORTED = Schema.Struct({ id: Schema.String });",
        "src/import-type.ts":
          'export const show = (value: (typeof import("./imported.ts").IMPORTED)["Type"]) => value.id;',
      }),
    ).toEqual([
      typeOnly("src/encoded.ts:3", "ENCODED"),
      typeOnly("src/entry.ts:3", "ENTRY"),
      typeOnly("src/imported.ts:3", "IMPORTED"),
      typeOnly("src/whole.ts:4", "WHOLE"),
    ]);
  }),
);

export const runtimeUsePasses = Task.make(
  "a schema that is decoded, encoded, passed to a function or put in an object passes, even when it is also read as a type",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/decoded.ts": `const ENTRY = Schema.Struct({ log: Schema.String });
export const decoded = (input: unknown): typeof ENTRY.Type => Schema.decodeUnknownSync(ENTRY)(input);`,
        "src/encoded.ts": `const COUNT = Schema.NumberFromString;
export const encoded = (count: typeof COUNT.Type) => Schema.encodeSync(COUNT)(count);`,
        "src/passed.ts": `const NAME = Schema.String;
inspect(NAME);
export const show = (name: typeof NAME.Type) => name;`,
        "src/shorthand.ts": `const TAG = Schema.Literal("tag");
export const SCHEMAS = { TAG };
export const show = (tag: typeof TAG.Type) => tag;`,
      }),
    ).toEqual([]);
  }),
);

export const effectApisThatTakeTheSchemaPass = Task.make(
  "a schema handed to a decoder, encoder, guard, assertion, error or class field, HttpApi endpoint, Rpc or Config.schema passes, even when also read as a type",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/codecs.ts": `const DECODED = Schema.Struct({ a: Schema.String });
const ENCODED = Schema.NumberFromString;
const GUARDED = Schema.String;
const ASSERTED = Schema.Number;
export const decode = Schema.decodeUnknownEffect(DECODED);
export const encode = Schema.encodeEffect(ENCODED);
export const isGuarded = Schema.is(GUARDED);
export const assertNumber = (input: unknown) => Schema.asserts(ASSERTED, input);
export const read = (
  decoded: typeof DECODED.Type,
  encoded: typeof ENCODED.Encoded,
  guarded: typeof GUARDED.Type,
  asserted: typeof ASSERTED.Type,
) => [decoded, encoded, guarded, asserted];`,
        "src/classes.ts": `const REASON = Schema.Literals(["missing", "late"]);
const NAME = Schema.String;
export class Failed extends Schema.TaggedError<Failed>()("Failed", { reason: REASON }) {}
export class Person extends Schema.Class<Person>("Person")({ name: NAME }) {}
export const describe = (reason: typeof REASON.Type, name: typeof NAME.Type) => [reason, name];`,
        "src/api.ts": `import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Rpc, RpcGroup } from "effect/rpc";
const USER = Schema.Struct({ id: Schema.String });
const USER_ID = Schema.String;
const TODO = Schema.Struct({ title: Schema.String });
export const Api = HttpApi.make("api").add(
  HttpApiGroup.make("users").add(
    HttpApiEndpoint.get("user", "/users/:id", { params: { id: USER_ID }, success: USER }),
  ),
);
export const Todos = RpcGroup.make(Rpc.make("todo", { success: TODO }));
export const show = (user: typeof USER.Type, id: typeof USER_ID.Type, todo: typeof TODO.Type) => [
  user,
  id,
  todo,
];`,
        "src/config.ts": `import { Config } from "effect";
const PORT = Schema.NumberFromString;
export const port = Config.schema(PORT, "PORT");
export const listen = (value: typeof PORT.Type) => value;`,
      }),
    ).toEqual([]);
  }),
);

export const compositionFollowsTheOuterSchema = Task.make(
  "a type-read schema composed into a decoded schema passes, and one composed only into type-only schemas is reported with them, recursion through Schema.suspend included",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/decoded.ts": `const LOG = Schema.Struct({ line: Schema.String });
const ENTRY = Schema.Struct({ log: LOG });
export const decoded = Schema.decodeUnknownSync(ENTRY);
export const line = (log: typeof LOG.Type) => log.line;`,
        "src/typed.ts": `const ENTRY = Schema.Struct({ log: Schema.String });
const LOGGED_ENTRY = Schema.Struct({ file: Schema.String, entry: ENTRY });
export const describe = (logged: typeof LOGGED_ENTRY.Type, entry: typeof ENTRY.Type) => [
  logged.file,
  entry.log,
];`,
        "src/recursive.ts": `interface Tree {
  readonly forest: ReadonlyArray<Tree>;
}
const TREE = Schema.Struct({
  forest: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => TREE)),
});
export const show = (tree: typeof TREE.Type) => tree.forest;`,
      }),
    ).toEqual([
      typeOnly("src/recursive.ts:6", "TREE"),
      typeOnly("src/typed.ts:3", "ENTRY"),
      typeOnly("src/typed.ts:4", "LOGGED_ENTRY"),
    ]);
  }),
);

export const schemaClassesFollowTheSameRule = Task.make(
  "a Schema.Class, Schema.TaggedClass or Schema.TaggedError referenced only as a type is reported, and one that is decoded, constructed, failed with or extended passes, as does one nothing outside its own declaration references",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/entry.ts": `export class Entry extends Schema.Class<Entry>("Entry")({ log: Schema.String }) {}
export const describe = (entry: Entry, raw: typeof Entry.Encoded) => [entry.log, raw.log];`,
        "src/tagged.ts": `export class Tagged extends Schema.TaggedClass<Tagged>()("Tagged", { id: Schema.String }) {}
export const show = (tagged: Tagged) => tagged.id;`,
        "src/typed-error.ts": `export class TypedError extends Schema.TaggedError<TypedError>()("TypedError", {}) {}
export const handle = (failure: TypedError) => failure._tag;`,
        "src/decoded.ts": `export class Decoded extends Schema.Class<Decoded>("Decoded")({ log: Schema.String }) {}
export const decode = (input: unknown): Decoded => Schema.decodeUnknownSync(Decoded)(input);`,
        "src/built.ts": `export class Built extends Schema.Class<Built>("Built")({ log: Schema.String }) {}
export const build = (): Built => new Built({ log: "built" });`,
        "src/failed.ts": `import { Effect } from "effect";
export class Failed extends Schema.TaggedError<Failed>()("Failed", {}) {}
export const fail = Effect.fail(new Failed());
export const handle = (failure: Failed) => failure._tag;`,
        "src/extended.ts": `class Base extends Schema.Class<Base>("Base")({ id: Schema.String }) {}
export class Derived extends Base {}
export const show = (base: Base) => base.id;`,
        "src/unused.ts":
          'export class Unused extends Schema.Class<Unused>("Unused")({ id: Schema.String }) {}',
      }),
    ).toEqual([
      typeOnly("src/entry.ts:3", "Entry"),
      typeOnly("src/tagged.ts:3", "Tagged"),
      typeOnly("src/typed-error.ts:3", "TypedError"),
    ]);
  }),
);

export const onlyTypeReadSchemasAreCandidates = Task.make(
  "values built from the Schema module that are not schemas, such as decoders, and schemas no typeof reads pass, so an unused schema is left to UnusedExport",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/decoder.ts": `const ENTRY = Schema.Struct({ log: Schema.String });
const decodeEntry = Schema.decodeUnknownSync(ENTRY);
export const keep = (decoded: ReturnType<typeof decodeEntry>) => decoded;`,
        "src/unused.ts": "export const UNUSED = Schema.Struct({ log: Schema.String });",
        "src/based.ts": `const BASE = Schema.Struct({ id: Schema.String });
const BRANDED = BASE.pipe(Schema.brand("Branded"));
export const keep = (branded: typeof BRANDED.Type) => branded;`,
      }),
    ).toEqual([typeOnly("src/based.ts:4", "BRANDED")]);
  }),
);

export const renamedReferencesResolveToTheirSchema = Task.make(
  "a schema decoded under another name, through import { X as Y }, a chain of renaming barrels, export { X as default }, import { default as Y } or import Y = ns.X passes, and one read as a type under another name is reported",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/renamed.ts": typeReadSchema("RENAMED"),
        "src/decode-renamed.ts": `import { RENAMED as LogEntry } from "./renamed.ts";
export const decodeRenamed = Schema.decodeUnknownSync(LogEntry);`,
        "src/chained.ts": typeReadSchema("CHAINED"),
        "src/first-barrel.ts": 'export { CHAINED as FIRST } from "./chained.ts";',
        "src/second-barrel.ts": 'export { FIRST as SECOND } from "./first-barrel.ts";',
        "src/decode-chained.ts": `import { SECOND as Chained } from "./second-barrel.ts";
export const decodeChained = Schema.decodeUnknownSync(Chained);`,
        "src/named-default.ts": `const NAMED_DEFAULT = Schema.Struct({ id: Schema.String });
export const show = (value: typeof NAMED_DEFAULT.Type) => value.id;
export { NAMED_DEFAULT as default };`,
        "src/decode-named-default.ts": `import NamedDefault from "./named-default.ts";
export const decodeNamedDefault = Schema.decodeUnknownSync(NamedDefault);`,
        "src/default-renamed.ts": `const DEFAULT_RENAMED = Schema.Struct({ id: Schema.String });
export const show = (value: typeof DEFAULT_RENAMED.Type) => value.id;
export { DEFAULT_RENAMED as default };`,
        "src/decode-default-renamed.ts": `import { default as Renamed } from "./default-renamed.ts";
export const decodeDefaultRenamed = Schema.decodeUnknownSync(Renamed);`,
        "src/equals.ts": typeReadSchema("EQUALS"),
        "src/decode-equals.ts": `import * as schemas from "./equals.ts";
import Equals = schemas.EQUALS;
export const decodeEquals = Schema.decodeUnknownSync(Equals);`,
        "src/typed.ts": "export const TYPED = Schema.Struct({ log: Schema.String });",
        "src/typed-barrel.ts": 'export { TYPED as TYPED_ENTRY } from "./typed.ts";',
        "src/show-typed.ts": `import { TYPED_ENTRY as Typed } from "./typed-barrel.ts";
export const showTyped = (value: typeof Typed.Type) => value.log;`,
      }),
    ).toEqual([typeOnly("src/typed.ts:3", "TYPED")]);
  }),
);

export const defaultExportsCountAsUses = Task.make(
  "a schema a file default-exports, by name or inside an expression, passes, since a default export is read as a value",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/named.ts": `const NAMED = Schema.Struct({ id: Schema.String });
export const show = (value: typeof NAMED.Type) => value.id;
export default NAMED;`,
        "src/read-named.ts": `import * as named from "./named.ts";
export const decodeNamed = Schema.decodeUnknownSync(named.default);`,
        "src/config.ts": `const CONFIG = Schema.Struct({ port: Schema.Number });
export const describe = (config: typeof CONFIG.Type) => config.port;
export default { schema: CONFIG };`,
        "src/sides.ts": `const LEFT = Schema.Struct({ left: Schema.String });
const RIGHT = Schema.Struct({ right: Schema.String });
export const side = (left: typeof LEFT.Type, right: typeof RIGHT.Type) => [left, right];
export default Schema.Union([LEFT, RIGHT]);`,
      }),
    ).toEqual([]);
  }),
);

export const namespaceMemberReadsAreFollowed = Task.make(
  "a schema read as ns.X through a namespace import, of its module or of a renaming barrel, passes when decoded and is reported when read only as typeof ns.X",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/decoded.ts": typeReadSchema("DECODED"),
        "src/barrel.ts": 'export { DECODED as RENAMED } from "./decoded.ts";',
        "src/decode.ts": `import * as direct from "./decoded.ts";
import * as barrel from "./barrel.ts";
export const decodeDirect = Schema.decodeUnknownSync(direct.DECODED);
export const decodeBarrel = Schema.decodeUnknownSync(barrel.RENAMED);`,
        "src/typed.ts": "export const TYPED = Schema.Struct({ id: Schema.String });",
        "src/show.ts": `import * as typed from "./typed.ts";
export const show = (value: typeof typed.TYPED.Type) => value.id;`,
      }),
    ).toEqual([typeOnly("src/typed.ts:3", "TYPED")]);
  }),
);

const WHOLE_MODULE_READS = [
  ["passed", "PASSED", 'import * as ns from "./passed.ts";\ninspect(ns);'],
  ["defaulted", "DEFAULTED", 'import * as ns from "./defaulted.ts";\nexport default ns;'],
  ["re-exported", "RE_EXPORTED", 'import * as ns from "./re-exported.ts";\nexport { ns };'],
  ["indexed", "INDEXED", 'import * as ns from "./indexed.ts";\ninspect(ns["INDEXED"]);'],
  [
    "destructured",
    "DESTRUCTURED",
    'import * as ns from "./destructured.ts";\nconst { DESTRUCTURED } = ns;\ninspect(DESTRUCTURED);',
  ],
  ["star-as", "STAR_AS", 'export * as ns from "./star-as.ts";'],
  [
    "dynamic",
    "DYNAMIC",
    'export const load = async () => {\n  const { DYNAMIC } = await import("./dynamic.ts");\n  return Schema.decodeUnknownSync(DYNAMIC);\n};',
  ],
  ["barreled", "BARRELED", 'import * as ns from "./barrel.ts";\ninspect(ns);'],
] as const;

const exportingModule = (name: string) => `${typeReadSchema(name)}
const HIDDEN_${name} = Schema.Struct({ id: Schema.String });
export const hide${name} = (value: typeof HIDDEN_${name}.Type) => value.id;`;

export const modulesReadWholeKeepEveryExport = Task.make(
  "every export of a module passes when a file reads its namespace as a value: passed on, default-exported, re-exported, indexed, destructured, export * as, or loaded with import(), through an export * barrel too, while the module's unexported schemas are still reported",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/barrel.ts": 'export * from "./barreled.ts";',
        ...Object.fromEntries(
          WHOLE_MODULE_READS.flatMap(([file, name, reader]) => [
            [`src/${file}.ts`, exportingModule(name)],
            [`src/read-${file}.ts`, reader],
          ]),
        ),
      }),
    ).toEqual(
      WHOLE_MODULE_READS.map(([file, name]) =>
        typeOnly(`src/${file}.ts:5`, `HIDDEN_${name}`),
      ).toSorted(),
    );
  }),
);

export const anImportOfATemplatePathWithoutExpressionsIsNamed = Task.make(
  "import() on a template literal with no expressions names its module like a string does: that module's exports pass, and other exported schemas are still reported",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "src/loaded.ts": typeReadSchema("LOADED"),
        "src/other.ts": typeReadSchema("OTHER"),
        "src/load.ts": "export const load = () => import(`./loaded.ts`);",
      }),
    ).toEqual([typeOnly("src/other.ts:3", "OTHER")]);
  }),
);

export const exportedSchemasAreReportedWhateverLoadsThePackage = Task.make(
  "a type-only schema is reported whether or not it is exported, in a package with main, module and exports entries pointing at its file, and when a file calls import() on a computed path; a local that shadows an export is reported on its own",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas({
        "package.json": yield* encodeJson({
          name: "library",
          type: "module",
          main: "./src/index.ts",
          module: "./src/index.ts",
          exports: { ".": "./src/index.ts" },
        }),
        "src/index.ts": `export const PUBLIC = Schema.Struct({ id: Schema.String });
export const show = (value: typeof PUBLIC.Type) => value.id;
const LISTED = Schema.Struct({ id: Schema.String });
export { LISTED };
export const showListed = (value: typeof LISTED.Type) => value.id;
const PRIVATE = Schema.Struct({ id: Schema.String });
export const hide = (value: typeof PRIVATE.Type) => value.id;
export const local = () => {
  const PUBLIC = Schema.Number;
  return (value: typeof PUBLIC.Type) => value;
};`,
        "src/load.ts": "export const load = (where: string) => import(where);",
      }),
    ).toEqual([
      typeOnly("src/index.ts:11", "PUBLIC"),
      typeOnly("src/index.ts:3", "PUBLIC"),
      typeOnly("src/index.ts:5", "LISTED"),
      typeOnly("src/index.ts:8", "PRIVATE"),
    ]);
  }),
);

export const filesOutsideTheProjectDoNotKeepExports = Task.make(
  "a schema decoded only by a script outside the TypeScript project is still reported, because reads from files outside the TypeScript project do not count as uses",
  Effect.gen(function* () {
    expect(
      yield* typeOnlySchemas(
        {
          "src/entry.ts": typeReadSchema("ENTRY"),
          "src/typed.ts": `const TYPED = Schema.Struct({ log: Schema.String });
export const showTyped = (typed: typeof TYPED.Type) => typed.log;`,
          "scripts/decode.ts": `import { ENTRY } from "../src/entry.ts";
export const decodeEntry = Schema.decodeUnknownSync(ENTRY);`,
        },
        { include: ["src/**/*.ts"] },
      ),
    ).toEqual([typeOnly("src/entry.ts:3", "ENTRY"), typeOnly("src/typed.ts:3", "TYPED")]);
  }),
);
