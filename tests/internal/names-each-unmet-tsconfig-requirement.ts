import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Record,
  Schema,
  Array as Arrays,
  flow,
} from "effect";

import { findInferrableAnnotations } from "../../src/lib/tasks/lib/detect-inferrable-annotations/internal/find-inferrable-annotations.ts";
import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { findTypeScriptConfigViolations } from "../../src/lib/tasks/shared/find-unmet-typescript-config-requirements.ts";
import {
  LooseCompilerOption,
  OPTIONS_TSC_LEAVES_UNSET,
  REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
  STRICT_OPTIONS,
} from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import { ProjectQueryCachesLive } from "../../src/lib/tasks/shared/provide-project-query-caches.ts";
import { openTypeScriptProjects } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import { formattedError, printableError } from "../../src/shared/format-reported-failures.ts";
import {
  theCheckCommand,
  FORMAT_CONFIG_TEXT,
  makeProject as makeProjectWith,
} from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { encodeIndentedJson } from "../shared/indented-json.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const taggedViolations = Arrays.map(flow(printableError, formattedError));

const IMPORTS_TASK =
  'import { Task } from "@sshkeda/task";\nexport const NAMED = Task.make.name;\n';

const projectExtending = (baseCompilerOptions: Readonly<Record<string, Schema.Json>>) =>
  Effect.gen(function* () {
    return yield* makeProject(
      {
        "base.json": yield* encodeJson({
          compilerOptions: {
            noEmit: true,
            skipLibCheck: true,
            ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
            ...baseCompilerOptions,
          },
        }),
        "tsconfig.json": yield* encodeJson({
          extends: "./base.json",
          files: ["src/index.ts", "oxlint.config.ts"],
        }),
        "src/index.ts": IMPORTS_TASK,
      },
      'lintConfig({ "base.json": { allow: ["hasAnUnlistedFileType"] } })',
    );
  });

const unmetRequirements = (projectFile: string) =>
  findTypeScriptConfigViolations(projectFile).pipe(
    Effect.map(() => new Array<string>()),
    Effect.catchTag("TypeScriptConfigViolations", (violations) =>
      Effect.succeed(taggedViolations(violations.violations)),
    ),
  );

const STRICT_BY_DEFAULT = "default: `true`, unless `strict` is `false`";

const TASK_LOADING_NOTICE = /^\[[^\]]+\] loading \S+\.ts$/u;

const HELP_ENTRY_FLAG = /^--(?<flag>\w+)(?:, -\S+)?\n/u;

const tscHelpEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const help = yield* Task.exec(path.resolve("node_modules/.bin/tsc"), ["--help", "--all"], {
    env: { FORCE_COLOR: "1" },
  });
  return Bun.stripANSI(help).split("\n\n");
});

const flagsOf = (entries: readonly string[]) =>
  entries.flatMap((entry) => HELP_ENTRY_FLAG.exec(entry)?.slice(1) ?? []);

const optionsDefaultingToStrict = tscHelpEntries.pipe(
  Effect.map((entries) => flagsOf(entries.filter((entry) => entry.includes(STRICT_BY_DEFAULT)))),
);

export const readsEveryFlagFromTscHelp = Task.make({
  name: "the tsc --help --all reader reads coloured output and flags that have a short form",
  run: Effect.gen(function* () {
    const flags = yield* Effect.map(tscHelpEntries, flagsOf);
    expect(
      ["build", "project", "strictNullChecks", "noCheck"].filter((flag) => !flags.includes(flag)),
    ).toEqual([]);
  }),
});

export const checksExactlyTheOptionsTscDefaultsFromStrict = Task.make({
  name: "the strict options check judges are strict and exactly the options tsc --help --all defaults from strict",
  run: Effect.gen(function* () {
    expect(["strict", ...(yield* optionsDefaultingToStrict)].toSorted()).toEqual(
      [...STRICT_OPTIONS].toSorted(),
    );
  }),
});

const OPTIONS_BEYOND_INDEX_AND_OPTIONAL_CHECKING = {
  noImplicitReturns: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noPropertyAccessFromIndexSignature: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
} as const;

const REQUIRED_OPTIONS = [
  ...STRICT_OPTIONS,
  ...Record.keys(REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT),
];

export const looseCompilerOptionNamesOnlyARequiredOption = Task.make({
  name: "LooseCompilerOption decodes an option check requires and refuses any other option",
  run: Effect.sync(() => {
    const decoded = Schema.decodeUnknownOption(LooseCompilerOption.fields.option);
    expect(REQUIRED_OPTIONS.map((option) => Option.isSome(decoded(option)))).toEqual(
      REQUIRED_OPTIONS.map(() => true),
    );
    expect(Option.isNone(decoded("noErrorTruncation"))).toBe(true);
  }),
});

export const judgesUnsetOptionsOutsideStrictByTheirTscDefault = Task.make({
  name: "every option check requires outside strict defaults to false in tsc --help --all, so an unset one resolves to false",
  run: Effect.gen(function* () {
    const entries = yield* tscHelpEntries;
    const optionsThatDefaultToFalse = Record.keys(REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT).filter(
      (option) => !OPTIONS_TSC_LEAVES_UNSET.has(option),
    );
    expect(
      optionsThatDefaultToFalse.map((option) =>
        entries.some(
          (entry) => entry.startsWith(`--${option}\n`) && entry.endsWith("default: false"),
        ),
      ),
    ).toEqual(optionsThatDefaultToFalse.map(() => true));
  }),
});

export const acceptsAConfigThatLeavesStrictUnset = Task.make({
  name: "a tsconfig whose extended base does not set strict meets every requirement because TypeScript 7 is strict by default",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* projectExtending({
      module: "CommonJS",
      moduleResolution: "Bundler",
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesStrictTurnedOffInAnExtendedBase = Task.make({
  name: "strict written as false in an extended base is reported against the project that resolves it",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* projectExtending({ strict: false });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${tsconfigFile}: error LooseCompilerOption: strict resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesEveryStrictOptionTurnedOffUnderStrict = Task.make({
  name: "every option that tsc defaults from strict is reported when written as false next to strict true",
  run: Effect.gen(function* () {
    const strictOptions = yield* optionsDefaultingToStrict;
    expect(strictOptions.length).toBeGreaterThan(0);
    const { tsconfigFile } = yield* projectExtending({
      strict: true,
      ...Object.fromEntries(strictOptions.map((option) => [option, false])),
    });
    expect((yield* unmetRequirements(tsconfigFile)).toSorted()).toEqual(
      strictOptions
        .map((option) => `${tsconfigFile}: error LooseCompilerOption: ${option} resolves to false`)
        .toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const followsOverridesAlongTheExtendsChain = Task.make({
  name: "a project that overrides its base's strict options is judged by the values it resolves to",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const turnedBackOn = yield* projectExtending({ strict: false, strictNullChecks: false });
    yield* fileSystem.writeFileString(
      turnedBackOn.tsconfigFile,
      yield* encodeJson({
        extends: "./base.json",
        compilerOptions: { strict: true, strictNullChecks: true },
        files: ["src/index.ts", "oxlint.config.ts"],
      }),
    );
    expect(yield* unmetRequirements(turnedBackOn.tsconfigFile)).toEqual([]);
    const turnedOff = yield* projectExtending({ strict: true });
    const middle = path.join(turnedOff.directory, "middle.json");
    yield* fileSystem.writeFileString(
      middle,
      yield* encodeJson({ extends: "./base.json", compilerOptions: { noImplicitAny: false } }),
    );
    yield* fileSystem.writeFileString(
      turnedOff.tsconfigFile,
      yield* encodeJson({ extends: "./middle.json", files: ["src/index.ts", "oxlint.config.ts"] }),
    );
    expect(yield* unmetRequirements(turnedOff.tsconfigFile)).toEqual([
      `${turnedOff.tsconfigFile}: error LooseCompilerOption: noImplicitAny resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const followsExtendsIntoAPackage = Task.make({
  name: "a strict option turned off in a tsconfig extended from a package is reported",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "node_modules/shared-config/package.json": yield* encodeJson({ name: "shared-config" }),
      "node_modules/shared-config/tsconfig.json": yield* encodeJson({
        compilerOptions: { strictFunctionTypes: false },
      }),
      "tsconfig.json": yield* encodeJson({
        extends: "shared-config/tsconfig.json",
        compilerOptions: {
          noEmit: true,
          skipLibCheck: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
        },
        files: ["main.ts", "oxlint.config.ts"],
      }),
      "main.ts": IMPORTS_TASK,
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${tsconfigFile}: error LooseCompilerOption: strictFunctionTypes resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesStrictOptionsTurnedOffInReferencedProjects = Task.make({
  name: "strict options turned off in referenced tsconfig and jsconfig projects are reported against each of them",
  run: Effect.gen(function* () {
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true },
        files: ["oxlint.config.ts"],
        references: [{ path: "./server" }, { path: "./web/jsconfig.json" }, { path: "./tools" }],
      }),
      "server/tsconfig.json": yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          strictNullChecks: false,
        },
        files: ["main.ts"],
      }),
      "server/main.ts": IMPORTS_TASK,
      "web/jsconfig.json": yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          checkJs: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          strict: false,
        },
        files: ["main.js"],
      }),
      "web/main.js": "export const WEB = 1;\n",
      "tools/tsconfig.json": yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
        },
        files: ["main.ts"],
      }),
      "tools/main.ts": IMPORTS_TASK,
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${path.join(directory, "server/tsconfig.json")}: error LooseCompilerOption: strictNullChecks resolves to false`,
      `${path.join(directory, "web/jsconfig.json")}: error LooseCompilerOption: strict resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

const solutionStyleProject = (referencedStrict: boolean) =>
  Effect.gen(function* () {
    return yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { strict: false },
        files: [],
        references: [{ path: "./server" }],
      }),
      "server/tsconfig.json": yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          strict: referencedStrict,
        },
        files: ["main.ts"],
      }),
      "server/main.ts": IMPORTS_TASK,
    });
  });

export const judgesOnlyProjectsThatCompileFiles = Task.make({
  name: "a solution-style root tsconfig that compiles no files is not judged, so its strict false passes when the referenced project is strict and only the referenced project is named when it is not",
  run: Effect.gen(function* () {
    const path = yield* Path.Path;
    expect(yield* unmetRequirements((yield* solutionStyleProject(true)).tsconfigFile)).toEqual([]);
    const { directory, tsconfigFile } = yield* solutionStyleProject(false);
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${path.join(directory, "server/tsconfig.json")}: error LooseCompilerOption: strict resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const refusesAnAbsoluteReferencePath = Task.make({
  name: "a reference whose path is absolute is reported at the referencing tsconfig and not followed, whether or not a project exists there, so it is neither judged nor reported missing under the referencing project's directory",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* solutionStyleProject(false);
    for (const referenced of [path.join(directory, "server"), path.join(directory, "missing")]) {
      yield* fileSystem.writeFileString(
        tsconfigFile,
        yield* encodeJson({
          compilerOptions: { strict: false },
          files: [],
          references: [{ path: referenced }],
        }),
      );
      expect(yield* unmetRequirements(tsconfigFile)).toEqual([
        `${tsconfigFile}: error AbsoluteProjectReference: references ${referenced} by an absolute path`,
      ]);
    }
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const acceptsACheckedJsconfigThatLeavesStrictUnset = Task.make({
  name: "a referenced jsconfig that sets checkJs and does not set strict meets every requirement",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true },
        files: ["oxlint.config.ts"],
        references: [{ path: "./web/jsconfig.json" }],
      }),
      "web/jsconfig.json": yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          checkJs: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
        },
        files: ["main.js"],
      }),
      "web/main.js": "export const WEB = 1;\n",
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesNoCheckInTheRootAndReferencedProjects = Task.make({
  name: "noCheck resolving to true in the root or a referenced project is reported because bun check then reports no type errors",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* projectExtending({ noCheck: true });
    yield* fileSystem.writeFileString(
      tsconfigFile,
      yield* encodeJson({
        extends: "./base.json",
        files: ["src/index.ts", "oxlint.config.ts"],
        references: [{ path: "./server" }],
      }),
    );
    yield* fileSystem.makeDirectory(path.join(directory, "server"));
    yield* fileSystem.writeFileString(
      path.join(directory, "server/tsconfig.json"),
      yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          noCheck: true,
        },
        files: ["main.ts"],
      }),
    );
    yield* fileSystem.writeFileString(path.join(directory, "server/main.ts"), IMPORTS_TASK);
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${tsconfigFile}: error LooseCompilerOption: noCheck resolves to true`,
      `${path.join(directory, "server/tsconfig.json")}: error LooseCompilerOption: noCheck resolves to true`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

const printedCheckOf = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const options = { cwd: directory };
    yield* fileSystem.writeFileString(
      path.join(directory, "package.json"),
      `${yield* encodeIndentedJson({ name: path.basename(directory), type: "module", main: "./src/index.ts" })}\n`,
    );
    yield* fileSystem.writeFileString(path.join(directory, ".gitignore"), "node_modules\n");
    yield* fileSystem.writeFileString(path.join(directory, "oxfmt.config.ts"), FORMAT_CONFIG_TEXT);
    yield* Task.exec("git", ["init", "--quiet"], options);
    yield* Task.exec("bun", ["fmt", "."], options);
    return yield* runTaskFile(yield* theCheckCommand, {
      ...options,
      taskStateDirectory: yield* fileSystem.makeTempDirectoryScoped(),
    }).pipe(
      failureAsValue,
      Effect.map((failure) =>
        Predicate.isTagged(failure, "CommandFailed") ? failure.standardOutput : failure.message,
      ),
    );
  });

export const checkRefusesNoCheckOverRealTypeErrors = Task.make({
  name: "check fails a project whose tsconfig sets noCheck over a real type error",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory } = yield* projectExtending({ noCheck: true });
    yield* fileSystem.writeFileString(
      path.join(directory, "src/index.ts"),
      `${IMPORTS_TASK}export const COUNT: number = NAMED;\n`,
    );
    const printed = yield* printedCheckOf(directory);
    expect(printed).toContain(
      "[typescript-config] tsconfig.json: error LooseCompilerOption: noCheck resolves to true",
    );
  }).pipe(Effect.scoped),
});

export const namesReferencesOfTheWrongShape = Task.make({
  name: "references written as something other than an array of { path } objects is reported against that file",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({ files: [], references: "./server" }),
    });
    const [malformed, ...rest] = yield* unmetRequirements(tsconfigFile);
    expect(rest).toEqual([]);
    expect(malformed).toStartWith(
      `${tsconfigFile}: error ProjectReferencesUndecodable: references do not decode:`,
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const acceptsAnUnbuiltBaseConfigWithNoInputs = Task.make({
  name: "a shared base tsconfig that only the root project extends and that has no inputs of its own meets every requirement, because nothing builds it",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "config/tsconfig.base.json": yield* encodeJson({
          compilerOptions: { strict: true, ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT },
        }),
        "src/index.ts": IMPORTS_TASK,
      },
      "lintConfig({})",
      { extends: "./config/tsconfig.base.json", include: ["src/**/*.ts", "oxlint.config.ts"] },
    );
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const judgesABaseConfigOnlyThroughTheProjectThatExtendsIt = Task.make({
  name: "a base tsconfig that sets strict to false is not reported when the tsconfig.json extending it sets strict back to true",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject(
      {
        "tsconfig.base.json": yield* encodeJson({
          compilerOptions: { strict: false, ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT },
        }),
        "src/index.ts": IMPORTS_TASK,
      },
      "lintConfig({})",
      { extends: "./tsconfig.base.json", include: ["src/**/*.ts", "oxlint.config.ts"] },
    );
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const leavesConfigErrorsOfAReferencedProjectToBunCheck = Task.make({
  name: "a referenced tsconfig that sets an option to the wrong type passes here because type-check builds it with bun check, which reports it",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true },
        files: ["oxlint.config.ts"],
        references: [{ path: "./server" }],
      }),
      "server/tsconfig.json": yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
          strict: "yes",
        },
        files: ["main.ts"],
      }),
      "server/main.ts": IMPORTS_TASK,
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const leavesJavaScriptToTheLintedFilesCheck = Task.make({
  name: "a project with allowJs and no checkJs meets every requirement, whether or not it compiles JavaScript, because linted-files-type-checked judges each file",
  run: Effect.gen(function* () {
    const withoutJavaScript = yield* projectExtending({ allowJs: true });
    expect(yield* unmetRequirements(withoutJavaScript.tsconfigFile)).toEqual([]);
    const withJavaScript = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true },
        files: ["oxlint.config.ts"],
        references: [{ path: "./web/jsconfig.json" }],
      }),
      "web/jsconfig.json": yield* encodeJson({
        compilerOptions: {
          composite: true,
          emitDeclarationOnly: true,
          ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
        },
        files: ["main.js"],
      }),
      "web/main.js": "export const WEB = 1;\n",
    });
    expect(yield* unmetRequirements(withJavaScript.tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesAnUnparsableReferencedProject = Task.make({
  name: "a referenced tsconfig that does not parse is reported against that file",
  run: Effect.gen(function* () {
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({ files: [], references: [{ path: "./server" }] }),
      "server/tsconfig.json": '{"compilerOptions": {,}}',
    });
    const [unparsable] = yield* unmetRequirements(tsconfigFile);
    expect(unparsable).toStartWith(
      `${path.join(directory, "server/tsconfig.json")}: error TypeScriptConfigUnparsable: does not parse as JSONC:`,
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesAMissingReferencedProject = Task.make({
  name: "a reference to a project without tsconfig.json gets a violation naming the missing file",
  run: Effect.gen(function* () {
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({ files: [], references: [{ path: "./server" }] }),
      "server/main.ts": IMPORTS_TASK,
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${path.join(directory, "server/tsconfig.json")}: error TypeScriptProjectFileMissing: does not exist`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const requiresNothingMoreOfAProjectImportingTask = Task.make({
  name: "a project importing @sshkeda/task whose extended base sets strict and the options check requires outside strict, and nothing else, meets every requirement",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* projectExtending({ strict: true });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const strictKeepsUndefinedOutOfInferrableAnnotations = Task.make({
  name: "only under strict does inferrable-annotations see that an annotation hides undefined, which is why check requires strict",
  run: Effect.gen(function* () {
    const annotationHidingUndefined =
      'const lookup = (key: string) => (key === "a" ? "found" : undefined);\nexport const shout = (key: string) => {\n  const found: string = lookup(key);\n  return found.toUpperCase();\n};\n';
    const violationsUnder = (strict: boolean) =>
      Effect.gen(function* () {
        const { tsconfigFile } = yield* makeProject({
          "tsconfig.json": yield* encodeJson({
            compilerOptions: { strict, types: [] },
            files: ["main.ts"],
          }),
          "main.ts": annotationHidingUndefined,
        });
        return yield* findInferrableAnnotations(
          tsconfigFile,
          openTypeScriptProjects(tsconfigFile),
        ).pipe(
          Effect.map(() => new Array<string>()),
          Effect.catchTag("InferrableTypeAnnotations", (found) =>
            Effect.succeed(taggedViolations(found.violations)),
          ),
        );
      });
    expect(yield* violationsUnder(true)).toEqual([]);
    expect((yield* violationsUnder(false)).join("\n")).toContain(
      "main.ts:3:16: error InferrableTypeAnnotation: found has a type annotation TypeScript can infer",
    );
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesAMissingProjectFile = Task.make({
  name: "a package without tsconfig.json gets a violation naming the missing file",
  run: Effect.gen(function* () {
    const path = yield* Path.Path;
    const { directory } = yield* makeProject({ "main.ts": "export const MAIN = 1;\n" });
    const missingProjectFile = path.join(directory, "missing/tsconfig.json");
    expect(yield* unmetRequirements(missingProjectFile)).toEqual([
      `${missingProjectFile}: error TypeScriptProjectFileMissing: does not exist`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const typedChecksWaitOnTheConfigInsteadOfFailingInDependencies = Task.make({
  name: "check prints the unmet tsconfig requirement once and the typed checks wait on it instead of reporting type errors",
  run: Effect.gen(function* () {
    const printed = yield* printedCheckOf(
      (yield* projectExtending({ strictNullChecks: false })).directory,
    );
    expect(printed).toContain(
      "[typescript-config] tsconfig.json: error LooseCompilerOption: strictNullChecks resolves to false",
    );
    expect(printed).toContain("[typed-checks] error AwaitedTaskFailed: typescript-config failed");
    expect(printed).toContain("[check] error SettledTasksFailed: 2 of 7 tasks failed");
    expect(printed).not.toContain("[type-check]");
    expect(
      printed
        .split("\n")
        .filter((line) => line.includes("node_modules") && !line.startsWith("[check] read "))
        .filter(
          (line) =>
            !/^\[[^\]]+\] {3}detected at \S+\/node_modules\/@sshkeda\/task\/src\//u.test(line),
        )
        .filter((line) => !TASK_LOADING_NOTICE.test(line)),
    ).toEqual([]);
  }).pipe(Effect.scoped),
});

export const typedChecksRunPastAFileNoProjectCompiles = Task.make({
  name: "a script file no project compiles fails linted-files-type-checked and does not stop typescript-config or type-check",
  run: Effect.gen(function* () {
    const { directory } = yield* makeProject(
      {
        "src/index.ts": `${IMPORTS_TASK}export const COUNT: number = NAMED;\n`,
        "src/stray.ts": "export const STRAY = 1;\n",
      },
      "lintConfig({})",
      { include: ["src/index.ts", "oxlint.config.ts"] },
    );
    const printed = yield* printedCheckOf(directory);
    expect(printed).toMatch(/^\[typescript-config\] passed in /mu);
    expect(printed).toContain("[type-check] src/index.ts:3:14: error TS2322");
    expect(printed).toContain(
      "[linted-files-type-checked] src/stray.ts: error LintedFileOutsideTypeScriptProgram: must be type-checked, but no program of tsconfig.json compiles it",
    );
    expect(printed).not.toContain("AwaitedTaskFailed");
  }).pipe(Effect.scoped),
});

export const printsANonBooleanStrictValueOnceFromBunCheck = Task.make({
  name: "check prints a non-boolean strict value once, from bun check, and typescript-config passes",
  run: Effect.gen(function* () {
    const printed = yield* printedCheckOf((yield* projectExtending({ strict: "yes" })).directory);
    expect(printed.split("\n").filter((line) => line.includes("error TS5024"))).toEqual([
      "[type-check] base.json:17:15: error TS5024: Compiler option 'strict' requires a value of type boolean.",
    ]);
    expect(printed).toMatch(/^\[typescript-config\] passed in /mu);
  }).pipe(Effect.scoped),
});

export const typeChecksAConsumerShapedProjectWithoutStrict = Task.make({
  name: "a consumer-shaped tsconfig with no strict key passes typescript-config and type-check reports strict errors",
  run: Effect.gen(function* () {
    const { directory } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: {
          target: "ES2024",
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          allowImportingTsExtensions: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noImplicitReturns: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noPropertyAccessFromIndexSignature: true,
          noImplicitOverride: true,
          noFallthroughCasesInSwitch: true,
          allowUnreachableCode: false,
          allowUnusedLabels: false,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          types: ["bun"],
          resolveJsonModule: true,
          plugins: [{ name: "@effect/language-service" }],
        },
        include: ["src/**/*.ts", "oxlint.config.ts"],
      }),
      "src/index.ts": `${IMPORTS_TASK}export const echo = (value) => value;\n`,
    });
    const printed = yield* printedCheckOf(directory);
    expect(printed).toMatch(/^\[typescript-config\] passed in /mu);
    expect(printed).toContain(
      "[type-check] src/index.ts:3:22: error TS7006: Parameter 'value' implicitly has an 'any' type.",
    );
  }).pipe(Effect.scoped),
});

export const namesIndexAndOptionalCheckingLeftUnset = Task.make({
  name: "a tsconfig that leaves noUncheckedIndexedAccess, exactOptionalPropertyTypes and allowImportingTsExtensions unset is reported once for each, because tsc then resolves each to false",
  run: Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: {
          ...OPTIONS_BEYOND_INDEX_AND_OPTIONAL_CHECKING,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ["src/index.ts", "oxlint.config.ts"],
      }),
      "src/index.ts": IMPORTS_TASK,
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${tsconfigFile}: error LooseCompilerOption: noUncheckedIndexedAccess resolves to false`,
      `${tsconfigFile}: error LooseCompilerOption: exactOptionalPropertyTypes resolves to false`,
      `${tsconfigFile}: error LooseCompilerOption: allowImportingTsExtensions resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesUnreachableCodeAndUnusedLabelsLeftUnset = Task.make({
  name: "a tsconfig that leaves allowUnreachableCode and allowUnusedLabels unset is reported once for each, because tsc then only suggests a fix instead of failing",
  run: Effect.gen(function* () {
    const { allowUnreachableCode, allowUnusedLabels, ...everyOtherOption } =
      REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT;
    const { tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...everyOtherOption, noEmit: true, skipLibCheck: true },
        files: ["src/index.ts", "oxlint.config.ts"],
      }),
      "src/index.ts": IMPORTS_TASK,
    });
    expect([allowUnreachableCode, allowUnusedLabels]).toEqual([false, false]);
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${tsconfigFile}: error LooseCompilerOption: allowUnreachableCode is unset`,
      `${tsconfigFile}: error LooseCompilerOption: allowUnusedLabels is unset`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

const unmetRequirementsWith = (compilerOptions: Readonly<Record<string, boolean | undefined>>) =>
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...compilerOptions, noEmit: true, skipLibCheck: true },
        files: ["src/index.ts", "oxlint.config.ts"],
      }),
      "src/index.ts": IMPORTS_TASK,
    });
    return { tsconfigFile, unmet: yield* unmetRequirements(tsconfigFile) };
  });

export const namesEachNewSettingLeftUnsetOrLoose = Task.make({
  name: "each setting Task and Check use is reported when it is unset or written with the wrong value, and passes with the required value",
  run: Effect.gen(function* () {
    for (const [option, required] of Record.toEntries(OPTIONS_BEYOND_INDEX_AND_OPTIONAL_CHECKING)) {
      const { [option]: _removed, ...everyOtherOption } = REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT;
      const unset = yield* unmetRequirementsWith(everyOtherOption);
      expect(unset.unmet).toEqual([
        OPTIONS_TSC_LEAVES_UNSET.has(option)
          ? `${unset.tsconfigFile}: error LooseCompilerOption: ${option} is unset`
          : `${unset.tsconfigFile}: error LooseCompilerOption: ${option} resolves to false`,
      ]);
      const loose = yield* unmetRequirementsWith({ ...everyOtherOption, [option]: !required });
      expect(loose.unmet).toEqual([
        `${loose.tsconfigFile}: error LooseCompilerOption: ${option} resolves to ${!required}`,
      ]);
      const met = yield* unmetRequirementsWith({ ...everyOtherOption, [option]: required });
      expect(met.unmet).toEqual([]);
    }
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

const rewritingProject = (rewrittenImportOptions: Readonly<Record<string, boolean>>) =>
  Effect.gen(function* () {
    return yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: {
          ...OPTIONS_BEYOND_INDEX_AND_OPTIONAL_CHECKING,
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: true,
          ...rewrittenImportOptions,
        },
        files: ["src/index.ts", "oxlint.config.ts"],
      }),
      "src/index.ts": IMPORTS_TASK,
    });
  });

export const acceptsRewrittenImportExtensions = Task.make({
  name: "rewriteRelativeImportExtensions set to true makes allowImportingTsExtensions resolve to true whether it is unset or false, while allowImportingTsExtensions written as false without it, or with it false, is still reported",
  run: Effect.gen(function* () {
    for (const passing of [
      { rewriteRelativeImportExtensions: true },
      { rewriteRelativeImportExtensions: true, allowImportingTsExtensions: false },
    ]) {
      expect(yield* unmetRequirements((yield* rewritingProject(passing)).tsconfigFile)).toEqual([]);
    }
    for (const failing of [
      { allowImportingTsExtensions: false },
      { rewriteRelativeImportExtensions: false, allowImportingTsExtensions: false },
    ]) {
      const { tsconfigFile } = yield* rewritingProject(failing);
      expect(yield* unmetRequirements(tsconfigFile)).toEqual([
        `${tsconfigFile}: error LooseCompilerOption: allowImportingTsExtensions resolves to false`,
      ]);
    }
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const namesIndexAndOptionalCheckingTurnedOffInAReferencedProject = Task.make({
  name: "noUncheckedIndexedAccess, exactOptionalPropertyTypes and allowImportingTsExtensions written as false in a referenced project are reported against it",
  run: Effect.gen(function* () {
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true },
        files: ["oxlint.config.ts"],
        references: [{ path: "./server" }],
      }),
      "server/tsconfig.json": yield* encodeJson({
        compilerOptions: {
          ...OPTIONS_BEYOND_INDEX_AND_OPTIONAL_CHECKING,
          composite: true,
          emitDeclarationOnly: true,
          noUncheckedIndexedAccess: false,
          exactOptionalPropertyTypes: false,
          allowImportingTsExtensions: false,
        },
        files: ["main.ts"],
      }),
      "server/main.ts": IMPORTS_TASK,
    });
    const server = path.join(directory, "server/tsconfig.json");
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${server}: error LooseCompilerOption: noUncheckedIndexedAccess resolves to false`,
      `${server}: error LooseCompilerOption: exactOptionalPropertyTypes resolves to false`,
      `${server}: error LooseCompilerOption: allowImportingTsExtensions resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

export const checkRefusesUncheckedIndexAccessOverAPossiblyMissingElement = Task.make({
  name: "check names noUncheckedIndexedAccess left unset over an index access that can miss, and the typed checks wait on it",
  run: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: {
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          exactOptionalPropertyTypes: true,
        },
        include: ["src/**/*.ts", "oxlint.config.ts"],
      }),
    });
    yield* fileSystem.makeDirectory(path.join(directory, "src"));
    yield* fileSystem.writeFileString(
      path.join(directory, "src/index.ts"),
      `${IMPORTS_TASK}export const firstWordLength = (text: string) => text.split(" ")[0].length;\n`,
    );
    const printed = yield* printedCheckOf(directory);
    expect(printed).toContain(
      "[typescript-config] tsconfig.json: error LooseCompilerOption: noUncheckedIndexedAccess resolves to false",
    );
    expect(printed).toContain("[typed-checks] error AwaitedTaskFailed: typescript-config failed");
  }).pipe(Effect.scoped),
});

const buildOutput = (projectFile: string, option: string) =>
  `${projectFile}: error BuildOutputCompilerOption: ${option} is set, but the package ships its TypeScript source and builds nothing`;

export const namesEveryBuildOptionOfTheRootProject = Task.make({
  name: "a root project that leaves noEmit unset, or resolves it to false and sets outDir, declaration, declarationDir and emitDeclarationOnly, is named for each, while declaration written as false passes",
  run: Effect.gen(function* () {
    const emitting = yield* makeProjectWith(
      {
        ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
        noEmit: false,
        outDir: "dist",
        declaration: true,
        declarationDir: "types",
        emitDeclarationOnly: true,
      },
      { "src/index.ts": IMPORTS_TASK },
    );
    expect(yield* unmetRequirements(emitting.tsconfigFile)).toEqual([
      `${emitting.tsconfigFile}: error LooseCompilerOption: noEmit resolves to false`,
      buildOutput(emitting.tsconfigFile, "outDir"),
      buildOutput(emitting.tsconfigFile, "declaration"),
      buildOutput(emitting.tsconfigFile, "declarationDir"),
      buildOutput(emitting.tsconfigFile, "emitDeclarationOnly"),
    ]);
    const unset = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, declaration: false },
        files: ["src/index.ts", "oxlint.config.ts"],
      }),
      "src/index.ts": IMPORTS_TASK,
    });
    expect(yield* unmetRequirements(unset.tsconfigFile)).toEqual([
      `${unset.tsconfigFile}: error LooseCompilerOption: noEmit is unset`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});

const referencedProject = (emitDeclarationOnly: Readonly<Record<string, boolean>>) =>
  encodeJson({
    compilerOptions: {
      composite: true,
      ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT,
      outDir: "../.declarations",
      ...emitDeclarationOnly,
    },
    files: ["main.ts"],
  });

export const requiresReferencedProjectsToEmitOnlyDeclarations = Task.make({
  name: "a referenced project, which bun check --build must let emit, passes with emitDeclarationOnly and an outDir, and is named when it leaves emitDeclarationOnly unset or false",
  run: Effect.gen(function* () {
    const path = yield* Path.Path;
    const { directory, tsconfigFile } = yield* makeProject({
      "tsconfig.json": yield* encodeJson({
        compilerOptions: { ...REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT, noEmit: true },
        files: ["oxlint.config.ts"],
        references: [{ path: "./server" }, { path: "./tools" }, { path: "./web" }],
      }),
      "server/tsconfig.json": yield* referencedProject({ emitDeclarationOnly: true }),
      "server/main.ts": IMPORTS_TASK,
      "tools/tsconfig.json": yield* referencedProject({}),
      "tools/main.ts": IMPORTS_TASK,
      "web/tsconfig.json": yield* referencedProject({ emitDeclarationOnly: false }),
      "web/main.ts": IMPORTS_TASK,
    });
    expect(yield* unmetRequirements(tsconfigFile)).toEqual([
      `${path.join(directory, "tools/tsconfig.json")}: error LooseCompilerOption: emitDeclarationOnly is unset`,
      `${path.join(directory, "web/tsconfig.json")}: error LooseCompilerOption: emitDeclarationOnly resolves to false`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(ProjectQueryCachesLive)),
});
