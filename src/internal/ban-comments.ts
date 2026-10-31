import { defineRule } from "@oxlint/plugins";

import { isDirective } from "../shared/lint-rule-messages-and-patterns.ts";

export const noComments = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow comments in code." },
    messages: { comment: "comment in code" },
  },
  create(context) {
    return {
      "Program:exit"() {
        for (const comment of context.sourceCode.getAllComments()) {
          const isCodeComment = comment.type !== "Shebang" && !isDirective(comment.value);
          if (isCodeComment) {
            context.report({ loc: comment.loc, messageId: "comment" });
          }
        }
      },
    };
  },
});
