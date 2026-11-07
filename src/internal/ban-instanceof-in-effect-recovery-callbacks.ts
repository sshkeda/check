import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import { effectOperation, resolvedVariable } from "./resolve-what-an-expression-imports.ts";

const innermostMemberObject = (node: ESTree.Node): ESTree.Node =>
  node.type === "MemberExpression" ? innermostMemberObject(node.object) : node;

export const noErrorInstanceof = defineRule({
  meta: {
    type: "problem",
    messages: {
      tagged: "instanceof tests a value reached from the parameter of Effect.{{operation}}",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== "instanceof") {
          return;
        }
        const subject = innermostMemberObject(node.left);
        if (subject.type !== "Identifier") {
          return;
        }
        const definition = resolvedVariable(subject, context.sourceCode)?.defs[0];
        if (definition?.type !== "Parameter") {
          return;
        }
        const callback = definition.node;
        const isNamedParameter =
          (callback.type === "ArrowFunctionExpression" ||
            callback.type === "FunctionExpression" ||
            callback.type === "FunctionDeclaration") &&
          callback.params.some((parameter) => parameter === definition.name);
        if (!isNamedParameter) {
          return;
        }
        const call = callback.parent;
        if (call.type !== "CallExpression") {
          return;
        }
        const operation = effectOperation(call.callee, context.sourceCode);
        if (operation === undefined) {
          return;
        }
        const isRecoveryOperation = operation.startsWith("catch") || operation === "mapError";
        if (isRecoveryOperation) {
          context.report({ node, messageId: "tagged", data: { operation } });
        }
      },
    };
  },
});
