import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const JOINING_OPERATORS: ReadonlySet<string> = new Set(["&&", "||"]);

const unwrappedNegation = (node: ESTree.Expression): ESTree.Expression => {
  const isNegation = node.type === "UnaryExpression" && node.operator === "!";
  return isNegation ? unwrappedNegation(node.argument) : node;
};

export const noUnnamedCompoundConditions = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      unnamed: "{{test}} condition joins checks with {{operator}} without a name",
    },
  },
  create(context) {
    const reportUnnamed = (test: ESTree.Expression, testKind: "if" | "ternary") => {
      const condition = unwrappedNegation(test);
      const joinsChecks =
        condition.type === "LogicalExpression" && JOINING_OPERATORS.has(condition.operator);
      if (joinsChecks) {
        context.report({
          node: test,
          messageId: "unnamed",
          data: { test: testKind, operator: condition.operator },
        });
      }
    };
    return {
      IfStatement(node) {
        reportUnnamed(node.test, "if");
      },
      ConditionalExpression(node) {
        reportUnnamed(node.test, "ternary");
      },
    };
  },
});
