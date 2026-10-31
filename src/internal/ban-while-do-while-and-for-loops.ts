import { defineRule } from "@oxlint/plugins";

export const noWhile = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Write loops as for...of over a known sequence, so no loop runs on a condition or counter that outside state must change.",
    },
    messages: {
      conditionLoop: "{{loop}} loops on a condition or counter that outside state must change",
    },
  },
  create(context) {
    return {
      WhileStatement(node) {
        context.report({ node, messageId: "conditionLoop", data: { loop: "while" } });
      },
      DoWhileStatement(node) {
        context.report({ node, messageId: "conditionLoop", data: { loop: "do...while" } });
      },
      ForStatement(node) {
        context.report({ node, messageId: "conditionLoop", data: { loop: "for" } });
      },
    };
  },
});
