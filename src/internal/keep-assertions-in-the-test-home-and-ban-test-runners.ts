import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  ASSERTION_MODULES,
  BUN_TEST,
  BUN_TEST_ASSERTIONS,
  isTestRunnerModule,
} from "../shared/lint-rule-messages-and-patterns.ts";
import { TEST_HOME } from "../shared/test-home-directories.ts";
import { importsOnlyTypes, moduleExportName } from "./resolve-what-an-expression-imports.ts";

const SIDE_EFFECT_IMPORT_KEYWORD = "import";
const A_TEST_RUNNER = "a test runner";

const imported = (node: ESTree.Node, name: string, isNamed: boolean) => ({
  node,
  name,
  isAssertion: isNamed && BUN_TEST_ASSERTIONS.has(name),
});

const visitValueImports = (
  sourceCode: SourceCode,
  checkModule: (
    source: ESTree.StringLiteral,
    specifiers: readonly {
      readonly node: ESTree.Node;
      readonly name: string;
      readonly isAssertion: boolean;
    }[],
  ) => void,
) => ({
  ImportDeclaration(declaration: ESTree.ImportDeclaration) {
    const valueSpecifiers = declaration.specifiers.filter(
      (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
    );
    if (!importsOnlyTypes(declaration, sourceCode)) {
      checkModule(
        declaration.source,
        valueSpecifiers.map((specifier) =>
          specifier.type === "ImportSpecifier"
            ? imported(specifier, moduleExportName(specifier.imported), true)
            : imported(specifier, specifier.local.name, false),
        ),
      );
    }
  },
});

export const noAssertions = defineRule({
  meta: {
    type: "problem",
    messages: {
      assertion: `asserts with {{assertion}} outside ${TEST_HOME}`,
    },
  },
  create(context) {
    return visitValueImports(context.sourceCode, (source, specifiers) => {
      if (ASSERTION_MODULES.has(source.value)) {
        context.report({ node: source, messageId: "assertion", data: { assertion: source.value } });
        return;
      }
      if (source.value !== BUN_TEST) {
        return;
      }
      for (const specifier of specifiers.filter(({ isAssertion }) => isAssertion)) {
        context.report({
          node: specifier.node,
          messageId: "assertion",
          data: { assertion: `${specifier.name} from ${BUN_TEST}` },
        });
      }
    });
  },
});

export const noTestRunners = defineRule({
  meta: {
    type: "problem",
    messages: {
      testRunner: "imports {{imported}} from {{source}}",
    },
  },
  create(context) {
    const reportTestRunnerModule = (node: ESTree.Node, source: string) => {
      context.report({
        node,
        messageId: "testRunner",
        data: { imported: A_TEST_RUNNER, source },
      });
    };
    const valueImports = visitValueImports(context.sourceCode, (source, specifiers) => {
      if (isTestRunnerModule(source.value)) {
        reportTestRunnerModule(source, source.value);
        return;
      }
      const runnerNames = specifiers
        .filter(({ isAssertion }) => !isAssertion)
        .map(({ name }) => name);
      const importsTestRunnerFromBunTest = source.value === BUN_TEST && runnerNames.length > 0;
      if (importsTestRunnerFromBunTest) {
        context.report({
          node: source,
          messageId: "testRunner",
          data: { imported: runnerNames.join(", "), source: BUN_TEST },
        });
      }
    });
    return {
      ImportDeclaration(declaration) {
        valueImports.ImportDeclaration(declaration);
        const loadsBunTestForSideEffects =
          declaration.source.value === BUN_TEST &&
          context.sourceCode.getTokenBefore(declaration.source)?.value ===
            SIDE_EFFECT_IMPORT_KEYWORD;
        if (loadsBunTestForSideEffects) {
          reportTestRunnerModule(declaration.source, BUN_TEST);
        }
      },
    };
  },
});
