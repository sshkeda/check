import { defineRule } from "@oxlint/plugins";

import { directivesAmong } from "../shared/lint-rule-messages-and-patterns.ts";

export const noComments = defineRule({
  meta: {
    type: "suggestion",
    messages: { comment: "comment in code" },
  },
  create(context) {
    return {
      "Program:exit"() {
        const { sourceCode } = context;
        const comments = sourceCode.getAllComments();
        const directives = new Set(directivesAmong(sourceCode.text, comments));
        for (const comment of comments) {
          const isCodeComment = comment.type !== "Shebang" && !directives.has(comment);
          if (isCodeComment) {
            context.report({ loc: comment.loc, messageId: "comment" });
          }
        }
      },
    };
  },
});
