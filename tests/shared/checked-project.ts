import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Schema } from "effect";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const PLUGIN = new URL("../../src/index.ts", import.meta.url).href;

const STAGED_CHECK = new URL("../../node_modules/@sshkeda/check-under-test/", import.meta.url);

const STAGED_FILES = ["package.json", "src", "scripts", "docs"] as const;

export const stagedCheckModule = (file: string) => new URL(file, STAGED_CHECK).href;

export const stageCheckUnderNodeModules = Task.make(
  "stage check under node_modules",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staged = yield* path.fromFileUrl(STAGED_CHECK);
    yield* fileSystem.remove(staged, { recursive: true, force: true });
    yield* fileSystem.makeDirectory(staged, { recursive: true });
    for (const file of STAGED_FILES) {
      yield* fileSystem.copy(file, path.join(staged, file));
    }
  }),
);

export const theCheckCommand = Effect.gen(function* () {
  const path = yield* Path.Path;
  const command = yield* path.fromFileUrl(new URL("scripts/check.ts", STAGED_CHECK));
  return `bun ${yield* encodeJson(command)}`;
});

export const RUNNER = import.meta.resolve("@sshkeda/task");

export const NO_PERMISSIONS = 0o000;

export const OWNER_WRITES_EVERYONE_READS = 0o644;

export const FORMAT_CONFIG_TEXT =
  'import { FORMAT_CONFIG } from "@sshkeda/check";\n\nexport default FORMAT_CONFIG;\n';

export const writtenFiles = (directory: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, text] of Object.entries(files)) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(directory, file), text);
    }
  });

export const linkNodeModulesWithCheck = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installed = path.resolve("node_modules");
    const linked = path.join(directory, "node_modules");
    const shim = path.join(linked, "@sshkeda", "check");
    yield* fileSystem.makeDirectory(shim, { recursive: true });
    for (const entry of yield* fileSystem.glob("{*,@sshkeda/*}", { root: installed, dot: true })) {
      if (entry !== "@sshkeda") {
        yield* fileSystem.symlink(path.join(installed, entry), path.join(linked, entry));
      }
    }
    yield* fileSystem.writeFileString(
      path.join(shim, "package.json"),
      yield* encodeJson({ name: "@sshkeda/check", type: "module", exports: "./index.js" }),
    );
    yield* fileSystem.writeFileString(
      path.join(shim, "index.js"),
      `export { FORMAT_CONFIG, lintConfig } from ${yield* encodeJson(PLUGIN)};\n`,
    );
  });

export const makeProject = (
  compilerRequirements: Readonly<Record<string, Schema.Json>>,
  sources: Readonly<Record<string, string>>,
  lintConfig = "lintConfig({})",
  projectFields: Readonly<Record<string, Schema.Json>> = {},
  parentDirectory?: string,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped(
        parentDirectory === undefined ? undefined : { directory: parentDirectory },
      ),
    );
    yield* linkNodeModulesWithCheck(directory);
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
          types: ["bun"],
          ...compilerRequirements,
        },
        include: ["**/*.ts"],
        ...projectFields,
      }),
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "package.json"),
      '{ "name": "checked", "type": "module" }\n',
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "oxlint.config.ts"),
      `import { lintConfig } from "@sshkeda/check";\nexport default ${lintConfig};\n`,
    );
    yield* writtenFiles(directory, sources);
    yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
    return {
      directory,
      tsconfigFile: path.join(directory, "tsconfig.json"),
      taskStateDirectory: yield* fileSystem.makeTempDirectoryScoped(),
    };
  });
