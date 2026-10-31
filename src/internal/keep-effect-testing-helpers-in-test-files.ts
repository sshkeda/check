import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  importedExpression,
  importsEmptyBraces,
  memberName,
  moduleExportName,
} from "./resolve-what-an-expression-imports.ts";

const EFFECT_PACKAGE = "effect";
const EFFECT_SCOPE = "@effect";
const PATH_SEPARATOR = "/";

const effectPathOf = (source: string) => {
  const segments = source.split(PATH_SEPARATOR);
  const [first, second, ...rest] = segments;
  if (first === EFFECT_PACKAGE) {
    return segments;
  }
  const isScopedEffectPackage = first === EFFECT_SCOPE && second !== undefined;
  return isScopedEffectPackage ? [`${first}${PATH_SEPARATOR}${second}`, ...rest] : undefined;
};

export const EFFECT_TESTING_MODULES: ReadonlySet<string> = new Set([
  "effect/ai/McpTest",
  "effect/cluster/TestRunner",
  "effect/http-api/HttpApiTest",
  "effect/rpc/RpcTest",
  "effect/testing",
  "effect/testing/TestClock",
  "effect/testing/TestConsole",
  "effect/testing/TestSchema",
]);

const EFFECT_TESTING_EXPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["@effect/platform-bun/BunHttpServer", new Set(["layerTest"])],
  ["effect/Layer", new Set(["PartialEffectful", "mock"])],
  ["effect/cluster/Entity", new Set(["makeTestClient"])],
  [
    "effect/graphql/GraphQLClient",
    new Set(["TestCallOptions", "TestHandler", "TestHandlers", "layerTest", "makeTest"]),
  ],
  ["effect/http/HttpServer", new Set(["layerServices", "layerTestClient", "makeTestClient"])],
]);

const testingHelperAt = (effectPath: readonly string[]) =>
  effectPath
    .flatMap((segment, index) => {
      const modulePath = effectPath.slice(0, index + 1).join(PATH_SEPARATOR);
      if (EFFECT_TESTING_MODULES.has(modulePath)) {
        return [modulePath];
      }
      const member = effectPath[index + 1];
      const isTestingExportOfModule =
        member !== undefined && EFFECT_TESTING_EXPORTS.get(modulePath)?.has(member);
      return isTestingExportOfModule === true ? [`${segment}.${member}`] : [];
    })
    .at(0);

const typeNameParts = (name: ESTree.Node): readonly string[] => {
  if (name.type === "TSQualifiedName") {
    return [...typeNameParts(name.left), name.right.name];
  }
  return name.type === "Identifier" ? [name.name] : [];
};

const typeNameRoot = (name: ESTree.Node): ESTree.Node =>
  name.type === "TSQualifiedName" ? typeNameRoot(name.left) : name;

const effectPathOfImported = (imported: ReturnType<typeof importedExpression>) => {
  const modulePath = imported && effectPathOf(imported.module);
  return imported && modulePath && [...modulePath, ...imported.members];
};

export const noTestingHelpers = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep Effect's testing helpers, the effect/testing modules and exports effect and @effect packages tag @category testing, in test files.",
    },
    messages: {
      testingHelper: "uses Effect's testing helper {{helper}} outside a test file",
    },
  },
  create(context) {
    const report = (node: ESTree.Node, helper: string) => {
      context.report({ node, messageId: "testingHelper", data: { helper } });
    };

    const effectPathOfExpression = (node: ESTree.Node) =>
      effectPathOfImported(importedExpression(node, context.sourceCode));

    const reportNewHelper = (node: ESTree.Node, effectPath: readonly string[] | undefined) => {
      if (effectPath === undefined) {
        return;
      }
      if (testingHelperAt(effectPath.slice(0, -1)) !== undefined) {
        return;
      }
      const helper = testingHelperAt(effectPath);
      if (helper !== undefined) {
        report(node, helper);
      }
    };

    const checkModule = (
      source: ESTree.StringLiteral,
      specifiers: readonly { readonly node: ESTree.Node; readonly name: string }[],
    ) => {
      const modulePath = effectPathOf(source.value);
      if (modulePath === undefined) {
        return;
      }
      const helper = testingHelperAt(modulePath);
      if (helper !== undefined) {
        report(source, helper);
        return;
      }
      for (const specifier of specifiers) {
        reportNewHelper(specifier.node, [...modulePath, specifier.name]);
      }
    };

    const qualifiedEffectPath = (name: ESTree.Node) => {
      const [, ...members] = typeNameParts(name);
      const rootPath = effectPathOfExpression(typeNameRoot(name));
      return rootPath && [...rootPath, ...members];
    };

    return {
      ImportDeclaration(declaration) {
        if (importsEmptyBraces(declaration, context.sourceCode)) {
          return;
        }
        checkModule(
          declaration.source,
          declaration.specifiers.flatMap((specifier) =>
            specifier.type === "ImportSpecifier"
              ? [{ node: specifier, name: moduleExportName(specifier.imported) }]
              : [],
          ),
        );
      },
      MemberExpression(expression) {
        const object = effectPathOfExpression(expression.object);
        const member = memberName(expression);
        const isNamedMemberOfEffectPath = object !== undefined && member !== undefined;
        reportNewHelper(expression, isNamedMemberOfEffectPath ? [...object, member] : undefined);
      },
      TSQualifiedName(name) {
        reportNewHelper(name, qualifiedEffectPath(name));
      },
    };
  },
});
