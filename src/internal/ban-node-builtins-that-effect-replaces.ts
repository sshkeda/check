import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  NODE_BUILTIN_RULES,
  nodeBuiltinNameOf,
} from "../shared/lint-rule-messages-and-patterns.ts";
import {
  importsOnlyTypes,
  moduleExportName,
  staticKeyName,
} from "./resolve-what-an-expression-imports.ts";

export const nodeBuiltinRule = (ruleName: keyof typeof NODE_BUILTIN_RULES) => {
  const bannedModules: ReadonlySet<string> = new Set(NODE_BUILTIN_RULES[ruleName].modules);
  const allowedImports: ReadonlySet<string> = new Set(NODE_BUILTIN_RULES[ruleName].allowedImports);
  const isErasedOrAllowed = (specifier: ESTree.ImportSpecifier) => {
    const isErased = specifier.importKind === "type";
    return isErased || allowedImports.has(moduleExportName(specifier.imported));
  };
  const importsOnlyAllowedNames = (node: ESTree.ImportDeclaration) =>
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.type === "ImportSpecifier" && isErasedOrAllowed(specifier),
    );
  return defineRule({
    meta: {
      type: "problem",
      messages: { builtin: "importing {{source}} is banned" },
    },
    create(context) {
      const check = (node: ESTree.Node, source: string) => {
        if (bannedModules.has(nodeBuiltinNameOf(source))) {
          context.report({ node, messageId: "builtin", data: { source } });
        }
      };

      return {
        ImportDeclaration(node) {
          const isAllowed =
            importsOnlyTypes(node, context.sourceCode) || importsOnlyAllowedNames(node);
          if (!isAllowed) {
            check(node.source, node.source.value);
          }
        },
        ImportExpression(node) {
          const source = staticKeyName(node.source);
          if (source !== undefined) {
            check(node.source, source);
          }
        },
      };
    },
  });
};
