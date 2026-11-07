import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const VAGUE_ERROR_NAME = /^(?:Failure|Error|Invalid|Unknown|Refused)+$/u;

export const noVagueErrorNames = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      vague: "error class {{name}} has a vague name",
    },
  },
  create(context) {
    const check = (node: ESTree.Class) => {
      const name = node.id?.name;
      const isVaguelyNamedSubclass =
        node.superClass !== null && name !== undefined && VAGUE_ERROR_NAME.test(name);
      if (isVaguelyNamedSubclass) {
        context.report({ node, messageId: "vague", data: { name } });
      }
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
});
