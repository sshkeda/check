import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  checkEffectDiagnosticsOfProject,
  EFFECT_DIAGNOSTIC_SEVERITY,
} from "../../src/lib/tasks/lib/check-effect-diagnostics-with-effect-tsgo/internal/check-effect-diagnostics-with-effect-tsgo.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";

const EFFECT_TSGO_SCHEMA = Schema.fromJsonString(
  Schema.Struct({
    definitions: Schema.Struct({
      effectLanguageServicePluginDiagnosticSeverityDefinition: Schema.Struct({
        properties: Schema.Record(Schema.String, Schema.Struct({ default: Schema.String })),
      }),
    }),
  }),
);

const EFFECT_TRY_CALLS_WITHOUT_CATCH = 2;

const diagnose = (source: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repository = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.symlink(
      path.join(repository, "node_modules"),
      path.join(directory, "node_modules"),
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "tsconfig.json"),
      yield* encodeJson({ extends: path.join(repository, "tsconfig.json"), include: ["main.ts"] }),
    );
    yield* fileSystem.writeFileString(path.join(directory, "main.ts"), source);
    return yield* checkEffectDiagnosticsOfProject(path.join(directory, "tsconfig.json"));
  }).pipe(Effect.scoped);

export const allowsUnstableApisWithExplicitRecovery = Task.make(
  "Effect diagnostics allow unstable APIs and do not recommend Effect.ignore or Effect.orDie",
  Effect.gen(function* () {
    yield* diagnose(
      'import { FileSystem } from "effect"; export const unstable = FileSystem.layerNoop;',
    );
    yield* diagnose(
      'import { Effect } from "effect"; export const recovered = Effect.fail("failure").pipe(Effect.catch(() => Effect.void));',
    );
  }),
);

export const leavesBuiltinImportsToOxlint = Task.make(
  "Effect diagnostics leave Node built-in imports to oxlint rules and reject crypto.randomUUID",
  Effect.gen(function* () {
    yield* diagnose(
      'import { appendFileSync } from "node:fs"; export const append = appendFileSync;',
    );
    const report = yield* diagnose("export const identifier = crypto.randomUUID();").pipe(
      Effect.as(""),
      Effect.catchTag("ToolExited", (exited) => Effect.succeed(exited.standardOutput)),
    );
    expect(report).toContain('"name": "cryptoRandomUUID"');
  }),
);

export const runsEffectDiagnosticsWithoutNode = Task.make(
  "Effect diagnostics use Bun when Node is not on PATH",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repository = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const nodeFreePath = yield* fileSystem.makeTempDirectoryScoped();
    const project = path.join(directory, "tsconfig.json");
    const source = path.join(directory, "main.ts");
    const driver = path.join(directory, "diagnose.ts");
    const implementation = path.join(
      repository,
      "src/lib/tasks/lib/check-effect-diagnostics-with-effect-tsgo/internal/check-effect-diagnostics-with-effect-tsgo.ts",
    );
    yield* fileSystem.symlink(
      path.join(repository, "node_modules"),
      path.join(directory, "node_modules"),
    );
    yield* fileSystem.writeFileString(
      project,
      yield* encodeJson({ extends: path.join(repository, "tsconfig.json"), include: ["main.ts"] }),
    );
    yield* fileSystem.writeFileString(
      driver,
      `import { BunServices } from "@effect/platform-bun";\nimport { Effect } from "effect";\nimport { checkEffectDiagnosticsOfProject } from ${yield* encodeJson(implementation)};\nconst result = checkEffectDiagnosticsOfProject(${yield* encodeJson(project)}).pipe(Effect.as("clean"), Effect.catchTag("ToolExited", (error) => Effect.succeed(error.standardOutput)), Effect.provide(BunServices.layer));\nconsole.log(await Effect.runPromise(result));\n`,
    );
    const diagnoseWithoutNode = () =>
      Task.exec(process.execPath, [driver], {
        cwd: repository,
        env: { PATH: nodeFreePath },
      });
    yield* fileSystem.writeFileString(source, "export const VALUE = 1;\n");
    expect(yield* diagnoseWithoutNode()).toContain("clean");
    yield* fileSystem.writeFileString(source, "export const IDENTIFIER = crypto.randomUUID();\n");
    expect(yield* diagnoseWithoutNode()).toContain('"name": "cryptoRandomUUID"');
  }).pipe(Effect.scoped),
);

export const rejectsUnknownInTheErrorChannel = Task.make(
  "Effect diagnostics reject an Effect whose error channel is unknown",
  Effect.gen(function* () {
    const report = yield* diagnose(
      'import { Effect } from "effect"; const value: unknown = 1; export const failed = Effect.fail(value);',
    ).pipe(
      Effect.as(""),
      Effect.catchTag("ToolExited", (exited) => Effect.succeed(exited.standardOutput)),
    );
    expect(report).toContain('"name": "anyUnknownInErrorContext"');
  }),
);

export const rejectsEffectTryWithoutCatch = Task.make(
  "Effect diagnostics reject Effect.try and Effect.tryPromise without a catch handler",
  Effect.gen(function* () {
    const report = yield* diagnose(
      'import { Effect } from "effect"; export const parsed = Effect.try(() => Number("1")); export const fetched = Effect.tryPromise(() => Promise.resolve(1));',
    ).pipe(
      Effect.as(""),
      Effect.catchTag("ToolExited", (exited) => Effect.succeed(exited.standardOutput)),
    );
    expect(
      report.split("\n").filter((line) => line.includes('"name": "effectTryWithoutCatch"')),
    ).toHaveLength(EFFECT_TRY_CALLS_WITHOUT_CATCH);
  }),
);

export const setsEverySeverityExplicitly = Task.make(
  "Effect diagnostics set the severity of exactly the diagnostics the installed @effect/tsgo schema lists",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repository = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const schema = yield* Schema.decodeEffect(EFFECT_TSGO_SCHEMA)(
      yield* fileSystem.readFileString(
        path.join(repository, "node_modules", "@effect", "tsgo", "schema.json"),
      ),
    );
    const listed = Object.keys(
      schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition.properties,
    );
    const configured = Object.keys(EFFECT_DIAGNOSTIC_SEVERITY);
    expect({
      unconfigured: listed.filter((name) => !configured.includes(name)),
      unlisted: configured.filter((name) => !listed.includes(name)),
    }).toEqual({ unconfigured: [], unlisted: [] });
  }),
);
