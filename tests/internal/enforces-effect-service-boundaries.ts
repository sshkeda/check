import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { PLUGIN } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { oxlintBinary } from "../shared/oxlint-binary.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const IMPORT_CONTEXT = 'import { Context } from "effect"; ';

export const serviceKeyNames = Task.make(
  "Effect service keys end in the named class including template literals, and an unnamed class is left to no-service-declarations",
  ruleTest("no-mismatched-service-keys", {
    valid: [
      ...[
        'class Store extends Context.Service<Store>()("@example/Store") {}',
        'class Store extends Context.Reference<Store>()("Store", {}) {}',
        `class Shutdown extends Context.Service<Shutdown>()(\`\${TASK_PACKAGE_NAME}/Shutdown\`) {}`,
        "class Store extends Context.Service<Store>()(`Store`) {}",
        'const service = class Store extends Context.Service<Store>()("Store") {};',
        'class Store extends Other.Service<Store>()("Unrelated") {}',
        'const service = class extends Context.Service()("Store") {};',
      ].map((code) => `${IMPORT_CONTEXT}${code}`),
      'const Context = { Service: () => () => class {} }; class Store extends Context.Service<Store>()("Other") {}',
    ],
    invalid: [
      {
        code: `${IMPORT_CONTEXT}class Store extends Context.Service<Store>()("@example/Other") {}`,
        errors: [{ message: "the service key ends with Other, not Store" }],
      },
      {
        code: `${IMPORT_CONTEXT}class Store extends Context.Reference<Store>()("Other", {}) {}`,
        errors: [{ messageId: "key" }],
      },
      {
        code: `${IMPORT_CONTEXT}class Shutdown extends Context.Service<Shutdown>()(\`\${TASK_PACKAGE_NAME}/Other\`) {}`,
        errors: [{ messageId: "key" }],
      },
      {
        code: `${IMPORT_CONTEXT}class Store extends Context.Service<Store>()(\`\${prefix}/\${dynamic}\`) {}`,
        errors: [{ message: "the service key of Store has no static last segment" }],
      },
      {
        code: `${IMPORT_CONTEXT}class Store extends Context.Service<Store>()(key) {}`,
        errors: [{ message: "the service key of Store has no static last segment" }],
      },
      {
        code: 'import { Context as Services } from "effect"; class Store extends Services.Service<Store>()("Other") {}',
        errors: [{ messageId: "key" }],
      },
      {
        code: 'import { Service } from "effect/Context"; class Store extends Service<Store>()("Other") {}',
        errors: [{ messageId: "key" }],
      },
    ],
  }),
);

export const serviceLocations = Task.make(
  "services require approved files while other property restrictions stay enabled",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const configFile = path.join(directory, "oxlint.config.ts");
      const allowedFile = path.join(directory, "allowed.ts");
      yield* fileSystem.writeFileString(
        configFile,
        `import { lintConfig } from ${yield* encodeJson(PLUGIN)};
const config = lintConfig({});
const rules = ["eslint/no-restricted-properties", "sshkeda/no-service-declarations"];
export default { jsPlugins: config.jsPlugins, rules: Object.fromEntries(rules.map((rule) => [rule, config.rules[rule]])), overrides: lintConfig({ "allowed.ts": { services: ["Store", "Limit"] } }).overrides };`,
      );
      yield* fileSystem.writeFileString(
        allowedFile,
        'import { Context } from "effect"; class Store extends Context.Service<Store>()("Store") {} class Limit extends Context.Reference<Limit>()("Limit", { defaultValue: () => 1 }) {}',
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "forbidden.ts"),
        'import { Context } from "effect"; Context.Service; Context.Reference;',
      );
      const binary = yield* oxlintBinary;
      const lint = (file: string) =>
        Task.exec("bun", [binary, "--config", configFile, "--format", "agent", file], {
          cwd: directory,
        });
      yield* lint("allowed.ts");
      expect((yield* lint("forbidden.ts").pipe(failureAsValue)).message).toContain(
        "declares a service outside a services file",
      );
      yield* fileSystem.writeFileString(allowedFile, "Date.now();");
      expect((yield* lint("allowed.ts").pipe(failureAsValue)).message).toContain(
        "'Date.now' is restricted",
      );
    }),
  ),
);
