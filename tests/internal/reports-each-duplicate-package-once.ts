import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { checkEffectDiagnosticsOfProject } from "../../src/lib/tasks/lib/check-effect-diagnostics-with-effect-tsgo/internal/check-effect-diagnostics-with-effect-tsgo.ts";
import { effectViolationsReport } from "../../src/lib/tasks/lib/check-effect-diagnostics-with-effect-tsgo/internal/read-effect-tsgo-json-report.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { formattedError } from "../../src/shared/format-reported-failures.ts";
import { writtenFiles } from "../shared/checked-project.ts";

const IMPORTING_SOURCE =
  'import { one } from "effect";\nimport { two } from "other";\nexport const VALUE = [one, two];\n';

export const duplicatedPackageIsReportedOnceForTheProject = Task.make(
  "a package installed at two versions is reported once with both versions and paths, however many source files import it",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repository = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* writtenFiles(directory, {
      "tsconfig.json": yield* encodeJson({
        extends: path.join(repository, "tsconfig.json"),
        include: ["*.ts"],
      }),
      "node_modules/effect/package.json": yield* encodeJson({
        name: "effect",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "node_modules/effect/index.d.ts": "export declare const one: 1;\n",
      "node_modules/other/package.json": yield* encodeJson({
        name: "other",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "node_modules/other/index.d.ts": 'export { two } from "effect";\n',
      "node_modules/other/node_modules/effect/package.json": yield* encodeJson({
        name: "effect",
        version: "2.0.0",
        types: "index.d.ts",
      }),
      "node_modules/other/node_modules/effect/index.d.ts": "export declare const two: 2;\n",
      "first.ts": IMPORTING_SOURCE,
      "second.ts": IMPORTING_SOURCE,
      "third.ts": IMPORTING_SOURCE,
    });
    const standardOutput = yield* checkEffectDiagnosticsOfProject(
      path.join(directory, "tsconfig.json"),
    ).pipe(
      Effect.as(""),
      Effect.catchTag("ToolExited", (exited) => Effect.succeed(exited.standardOutput)),
    );
    const { violations } = yield* effectViolationsReport("effect-tsgo", standardOutput);
    expect(violations.map((violation) => formattedError(violation))).toEqual([
      `error effect(duplicatePackage): Multiple versions of package \`effect\` were detected: 1.0.0 @ ${path.join(directory, "node_modules/effect")}, 2.0.0 @ ${path.join(directory, "node_modules/other/node_modules/effect")}. Package duplication can change runtime identity and type equality across Effect modules.\n  If this is intentional, set the LSP config \`allowedDuplicatedPackages\` to ["effect"].`,
    ]);
  }).pipe(Effect.scoped),
);
