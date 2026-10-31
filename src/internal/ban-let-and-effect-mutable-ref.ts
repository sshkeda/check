import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { effectModuleReference } from "./resolve-what-an-expression-imports.ts";

const bindingNamesOf = (pattern: ESTree.Node): readonly string[] => {
  if (pattern.type === "Identifier") {
    return [pattern.name];
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      bindingNamesOf(property.type === "RestElement" ? property.argument : property.value),
    );
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => (element === null ? [] : bindingNamesOf(element)));
  }
  if (pattern.type === "RestElement") {
    return bindingNamesOf(pattern.argument);
  }
  return pattern.type === "AssignmentPattern" ? bindingNamesOf(pattern.left) : [];
};

export const noLet = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Declare every variable with const, including for...of and for...in loop variables, so no name is reassigned. A let that starts a for statement is left to no-while, which reports the whole loop.",
    },
    messages: {
      reassignable: "let declares {{names}}, which can be reassigned",
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        const isLetNotStartingAForStatement =
          node.kind === "let" && node.parent.type !== "ForStatement";
        if (isLetNotStartingAForStatement) {
          context.report({
            node,
            messageId: "reassignable",
            data: {
              names: node.declarations
                .flatMap((declarator) => bindingNamesOf(declarator.id))
                .join(", "),
            },
          });
        }
      },
    };
  },
});

export const noMutableRef = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Keep shared state in an Effect Ref instead of MutableRef, the synchronous box that would stand in for a banned let.",
    },
    messages: {
      boxedVariable: "{{usage}} keeps a reassignable value in a synchronous box",
    },
  },
  create(context) {
    const reportMutableRef = (node: ESTree.Node) => {
      const usage = effectModuleReference(node, context.sourceCode, "MutableRef");
      if (usage !== undefined) {
        context.report({ node, messageId: "boxedVariable", data: { usage } });
      }
    };
    return {
      Identifier: reportMutableRef,
      MemberExpression: reportMutableRef,
    };
  },
});
