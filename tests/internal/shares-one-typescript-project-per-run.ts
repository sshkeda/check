import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Ref, Result } from "effect";

import { runChecksOverOneTypeScriptProject } from "../../src/lib/tasks/internal/run-checks-over-one-typescript-project.ts";
import { findImportBoundaryViolations } from "../../src/lib/tasks/lib/check-import-boundaries/internal/find-import-boundary-violations.ts";
import { findDeclaredUseViolations } from "../../src/lib/tasks/lib/check-uses-by-their-declarations/internal/find-declared-use-violations.ts";
import { findUngrantedStdioUses } from "../../src/lib/tasks/lib/confine-stdio-to-granted-files/internal/find-ungranted-stdio-uses.ts";
import { findInferrableAnnotations } from "../../src/lib/tasks/lib/detect-inferrable-annotations/internal/find-inferrable-annotations.ts";
import { findRepeatedServiceYields } from "../../src/lib/tasks/lib/detect-repeated-service-yields/internal/find-repeated-service-yields.ts";
import { findExportPlacementViolations } from "../../src/lib/tasks/lib/place-exports-in-the-narrowest-directory/internal/find-export-placement-violations.ts";
import { findErrorMappingsToDone } from "../../src/lib/tasks/lib/refuse-error-mappings-that-end-streams/internal/find-error-mappings-to-done.ts";
import { findServiceLayerViolations } from "../../src/lib/tasks/lib/require-separate-service-layers/internal/find-service-layer-violations.ts";
import { moduleResolverFor } from "../../src/lib/tasks/shared/create-the-module-resolver.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { resolveModuleRequest } from "../../src/lib/tasks/shared/resolve-module-requests.ts";
import {
  makeProject as makeProjectWith,
  NO_PERMISSIONS,
  OWNER_WRITES_EVERYONE_READS,
  writtenFiles,
} from "../shared/checked-project.ts";
import { failureAsValue, outcomeOf } from "../shared/failure-as-value.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

export const checksQueryOneSharedProject = Task.make(
  "the checks that query TypeScript take the project set opened once for the run, so none opens its own",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "a.ts": 'import { Effect } from "effect";\nexport const RUN = Effect.void;\n',
    });
    const opened = yield* openTypeScriptProjects(tsconfigFile);
    const reads = yield* Ref.make(0);
    const openedProjects = Ref.update(reads, (count) => count + 1).pipe(Effect.as(opened));
    const results = yield* Effect.all([
      outcomeOf(findRepeatedServiceYields(tsconfigFile, openedProjects)),
      outcomeOf(findServiceLayerViolations(tsconfigFile, openedProjects)),
      outcomeOf(findUngrantedStdioUses(tsconfigFile, openedProjects)),
      outcomeOf(findDeclaredUseViolations(tsconfigFile, openedProjects)),
      outcomeOf(findExportPlacementViolations(tsconfigFile, openedProjects)),
      outcomeOf(findInferrableAnnotations(tsconfigFile, openedProjects)),
    ]);
    expect(yield* Ref.get(reads)).toBe(results.length);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const checksShareEachCallsSignature = Task.make(
  "the checks that read each call's declaration resolve every call's signature once between them",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "a.ts":
        'import { Effect } from "effect";\nexport const RUN = Effect.void.pipe(Effect.as(1), Effect.map((value) => value + 1));\n',
    });
    const opened = yield* openTypeScriptProjects(tsconfigFile);
    const resolvedCalls: unknown[] = [];
    for (const { checker } of opened) {
      const resolve = checker.getResolvedSignature.bind(checker);
      checker.getResolvedSignature = (node) => {
        resolvedCalls.push(node);
        return resolve(node);
      };
    }
    const openedProjects = Effect.succeed(opened);
    yield* outcomeOf(findDeclaredUseViolations(tsconfigFile, openedProjects));
    const resolvedByOneCheck = resolvedCalls.length;
    yield* outcomeOf(findErrorMappingsToDone(tsconfigFile, openedProjects));
    expect(resolvedByOneCheck).toBeGreaterThan(0);
    expect(resolvedCalls.length).toBe(resolvedByOneCheck);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const checksShareEachModuleResolution = Task.make(
  "the import-boundary and export-placement checks resolve each module request of a file once between them",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "a.ts": 'import { B } from "./b.ts";\nexport const A = B;\n',
      "b.ts": "export const B = 1;\n",
    });
    const resolver = yield* moduleResolverFor([]);
    const resolve = resolver.resolveFileAsync.bind(resolver);
    const resolvedRequests: string[] = [];
    resolver.resolveFileAsync = (importingFile, request) => {
      resolvedRequests.push(request);
      return resolve(importingFile, request);
    };
    yield* outcomeOf(findImportBoundaryViolations(tsconfigFile));
    const resolvedByOneCheck = [...resolvedRequests];
    yield* outcomeOf(
      findExportPlacementViolations(tsconfigFile, openTypeScriptProjects(tsconfigFile)),
    );
    resolver.resolveFileAsync = resolve;
    expect(resolvedByOneCheck).toContain("./b.ts");
    expect(resolvedRequests).toEqual(resolvedByOneCheck);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

const UNREADABLE_MANIFEST = "cannot be read as a package.json whose name, if any, is a string";

const resolutionOf = (request: string, importingFile: string, projectDirectory: string) =>
  outcomeOf(
    resolveModuleRequest({ request, importingFile, customConditions: [], projectDirectory }),
  ).pipe(
    Effect.map(
      Result.match({
        onFailure: (error) => [error._tag, error.message],
        onSuccess: (resolved) => [resolved?.packageName, resolved?.packageRoot],
      }),
    ),
  );

export const unreadableManifestsFailResolution = Task.make(
  "resolving a module whose package.json does not decode, a symlink to itself included, fails with ModuleRequestUnresolvable naming that package.json once, relative to the project, and why on one line, instead of treating the package as unnamed, and a package's root is its manifest's directory",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const importer = path.join(directory, "a.ts");
    yield* fileSystem.writeFileString(importer, "");
    for (const [name, manifest] of [
      ["named", '{ "name": "named", "main": "index.js" }'],
      ["misnamed", '{ "name": 5, "main": "index.js" }'],
      ["nulled", '{ "name": null, "main": "index.js" }'],
      ["locked", '{ "name": "locked", "main": "index.js" }'],
    ] as const) {
      yield* writtenFiles(path.join(directory, "node_modules", name), {
        "package.json": manifest,
        "index.js": "",
      });
    }
    const locked = path.join(directory, "node_modules", "locked", "package.json");
    yield* fileSystem.chmod(locked, NO_PERMISSIONS);
    yield* writtenFiles(path.join(directory, "node_modules", "looped"), {
      "package.json": '{ "name": "looped", "main": "inner/index.js" }',
      "inner/index.js": "",
    });
    yield* fileSystem.symlink(
      "package.json",
      path.join(directory, "node_modules", "looped", "inner", "package.json"),
    );
    const named = yield* resolveModuleRequest({
      request: "named",
      importingFile: importer,
      customConditions: [],
      projectDirectory: directory,
    });
    expect(named?.packageName).toBe("named");
    expect(named?.packageRoot).toBe(path.join(directory, "node_modules", "named"));
    const failures = yield* Effect.forEach(["misnamed", "nulled", "locked", "looped"], (name) =>
      resolutionOf(name, importer, directory),
    );
    yield* fileSystem.chmod(locked, OWNER_WRITES_EVERYONE_READS);
    expect(failures).toEqual([
      [
        "ModuleRequestUnresolvable",
        `could not resolve misnamed: node_modules/misnamed/package.json ${UNREADABLE_MANIFEST}: Expected string at ["name"]`,
      ],
      [
        "ModuleRequestUnresolvable",
        `could not resolve nulled: node_modules/nulled/package.json ${UNREADABLE_MANIFEST}: Expected string at ["name"]`,
      ],
      [
        "ModuleRequestUnresolvable",
        `could not resolve locked: node_modules/locked/package.json ${UNREADABLE_MANIFEST}: reading it failed with EACCES`,
      ],
      [
        "ModuleRequestUnresolvable",
        `could not resolve looped: node_modules/looped/inner/package.json ${UNREADABLE_MANIFEST}: reading it failed with ELOOP`,
      ],
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const aResolutionErrorIsExplainedByThePackageJsonsAround = Task.make(
  "when the resolver finds no file but fails, resolution reads the package.json files around the importer and, for a relative path, around its target, so a package.json that is no JSON fails it by its path even when the project's path holds a \", while a resolver failure that no package.json explains, such as an empty path or a package whose package.json is no JSON, fails it with the resolver's words, and a missing file, a missing package or a built-in module is still no file",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const project = path.join(directory, 'quo"te');
    yield* writtenFiles(project, {
      "package.json": '{ "name": "p" }',
      "src/m/index.ts": "",
      "src/m/internal/package.json": "{ name: bad }",
      "src/m/internal/a.ts": "",
      "node_modules/broken/package.json": "{ broken",
      "node_modules/broken/index.ts": "",
    });
    const importer = path.join(project, "src/m/index.ts");
    const resolverFailure = (request: string) =>
      moduleResolverFor([]).pipe(
        Effect.flatMap((resolver) =>
          Effect.promise(() => resolver.resolveFileAsync(importer, request)),
        ),
        Effect.map((resolved) => resolved.error ?? "no error"),
      );
    const resolutions = yield* Effect.forEach(
      ["./internal/a.ts", "", "broken", "./missing.ts", "missing", "node:fs", "node:nope"],
      (request) => resolutionOf(request, importer, project),
    );
    expect(resolutions).toEqual([
      [
        "ModuleRequestUnresolvable",
        `could not resolve ./internal/a.ts: src/m/internal/package.json ${UNREADABLE_MANIFEST}: Expected a valid JSON string`,
      ],
      ["ModuleRequestUnresolvable", `could not resolve : ${yield* resolverFailure("")}`],
      [
        "ModuleRequestUnresolvable",
        `could not resolve broken: ${yield* resolverFailure("broken")}`,
      ],
      ...Array.from({ length: 4 }, () => [undefined, undefined]),
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const onlyANamedManifestMakesAPackage = Task.make(
  "resolving a module takes its package from the nearest package.json with a string name, so a package.json with no name, and a directory named package.json, make no package and leave the module in the enclosing named package, a package.json that starts with a UTF-8 byte order mark is read as Node and oxc read it, and a package's root is its named manifest's directory",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const importer = path.join(directory, "a.ts");
    yield* fileSystem.writeFileString(importer, "");
    yield* fileSystem.writeFileString(path.join(directory, "package.json"), '{ "name": "outer" }');
    for (const [name, manifest] of [
      ["named", '{ "name": "named", "main": "index.js" }'],
      ["module", '{ "type": "module" }'],
      ["side-effect-free", '{ "sideEffects": false }'],
      ["marked", '\uFEFF{"name":"marked"}\n'],
      ["marked-empty", "\uFEFF{}\n"],
      ["directory", undefined],
    ] as const) {
      const packageDirectory = path.join(directory, "src", name);
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      const manifestFile = path.join(packageDirectory, "package.json");
      yield* manifest === undefined
        ? fileSystem.makeDirectory(manifestFile)
        : fileSystem.writeFileString(manifestFile, manifest);
      yield* fileSystem.writeFileString(path.join(packageDirectory, "index.js"), "");
    }
    const packageOf = (name: string) =>
      resolveModuleRequest({
        request: `./src/${name}/index.js`,
        importingFile: importer,
        customConditions: [],
        projectDirectory: directory,
      }).pipe(Effect.map((resolved) => [resolved?.packageName, resolved?.packageRoot]));
    expect(yield* packageOf("named")).toEqual(["named", path.join(directory, "src", "named")]);
    expect(yield* packageOf("marked")).toEqual(["marked", path.join(directory, "src", "marked")]);
    for (const name of ["module", "side-effect-free", "marked-empty", "directory"]) {
      expect(yield* packageOf(name)).toEqual(["outer", directory]);
    }
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const aPackageJsonAboveTheProjectIsNeverRead = Task.make(
  "resolution stops looking for the nearest package.json with a string name at the project's root, so a package.json above a project whose own package.json has no name is never read, even when it is no JSON, and the project's files belong to no named package",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const project = path.join(directory, "project");
    yield* writtenFiles(directory, {
      "package.json": "{ broken\n",
      "project/package.json": '{ "private": true }\n',
      "project/a.ts": "",
      "project/src/b.ts": "",
    });
    expect(yield* resolutionOf("./src/b.ts", path.join(project, "a.ts"), project)).toEqual([
      null,
      null,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);

export const oneCrashingCheckLeavesTheOthersReporting = Task.make(
  "a checker query that dies is reported as that check's CheckCrashed while every other check over the same project still reports its violations, each named by its check",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "a.ts": `import { Context, Effect } from "effect";
export class WorkerPool extends Context.Service<WorkerPool, { readonly run: Effect.Effect<void> }>()("WorkerPool") {}
export const program = Effect.gen(function* () {
  const first = yield* WorkerPool;
  const second = yield* WorkerPool;
  return [first, second];
});
`,
    });
    const failure = yield* runChecksOverOneTypeScriptProject(tsconfigFile, {
      crashing: () => Effect.die(new Error("the check broke")),
      "service-yields": findRepeatedServiceYields,
    }).pipe(failureAsValue);
    expect(failure.reportedErrors.map(({ tag }) => tag).toSorted()).toEqual([
      "crashing CheckCrashed",
      "service-yields RepeatedServiceYield",
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
);
