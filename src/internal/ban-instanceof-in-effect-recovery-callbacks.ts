import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import {
  effectOperation,
  enclosingFunction,
  resolvedVariable,
} from "./resolve-what-an-expression-imports.ts";

const innermostMemberObject = (node: ESTree.Node): ESTree.Node =>
  node.type === "MemberExpression" ? innermostMemberObject(node.object) : node;

export const noErrorInstanceof = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Use tagged failures in Effect recovery callbacks." },
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
        const callback = enclosingFunction(node);
        if (!callback) {
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
        if (!isRecoveryOperation) {
          return;
        }
        const subject = innermostMemberObject(node.left);
        if (subject.type !== "Identifier") {
          return;
        }
        const subjectName = subject.name;
        const parameter = callback.params.find(
          (candidate) => candidate.type === "Identifier" && candidate.name === subjectName,
        );
        if (parameter?.type !== "Identifier") {
          return;
        }
        const parameterVariable = context.sourceCode
          .getDeclaredVariables(callback)
          .find((variable) => variable.identifiers.includes(parameter));
        if (resolvedVariable(subject, context.sourceCode) === parameterVariable) {
          context.report({ node, messageId: "tagged", data: { operation } });
        }
      },
    };
  },
});
