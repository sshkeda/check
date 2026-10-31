import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  NODE_BUILTIN_RULES,
  nodeBuiltinNameOf,
} from "../shared/lint-rule-messages-and-patterns.ts";
import { importsOnlyTypes, staticKeyName } from "./resolve-what-an-expression-imports.ts";

export const nodeBuiltinRule = (ruleName: keyof typeof NODE_BUILTIN_RULES) => {
  const bannedModules: ReadonlySet<string> = new Set(NODE_BUILTIN_RULES[ruleName].modules);
  return defineRule({
    meta: {
      type: "problem",
      docs: {
        description: `Import ${[...bannedModules].join(", ")} from Node only through its Effect replacement, a literal import() included; a re-export is left to no-re-exports and an import {} to typescript(no-import-type-side-effects).`,
      },
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
          if (!importsOnlyTypes(node, context.sourceCode)) {
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
