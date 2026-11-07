import { defineRule } from "@oxlint/plugins";

import { GLOBAL_RULES } from "../shared/lint-rule-messages-and-patterns.ts";
import {
  isGlobalReference,
  isMemberExpressionObject,
  isReferencePosition,
  isShorthandKey,
} from "./resolve-what-an-expression-imports.ts";

export const globalRule = (ruleName: keyof typeof GLOBAL_RULES) => {
  const restrictedGlobals: ReadonlySet<string> = new Set(GLOBAL_RULES[ruleName].globals);
  return defineRule({
    meta: {
      type: "problem",
      messages: { global: "global {{name}} is used" },
    },
    create(context) {
      return {
        Identifier(node) {
          const isRestrictedGlobalReference =
            restrictedGlobals.has(node.name) &&
            !isShorthandKey(node) &&
            (isMemberExpressionObject(node) || isReferencePosition(node)) &&
            isGlobalReference(node, context.sourceCode, node.name);
          if (isRestrictedGlobalReference) {
            context.report({ node, messageId: "global", data: { name: node.name } });
          }
        },
      };
    },
  });
};
