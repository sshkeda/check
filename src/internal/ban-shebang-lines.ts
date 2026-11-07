import { defineRule } from "@oxlint/plugins";

export const noShebang = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      shebang: "file starts with a shebang line",
    },
  },
  create(context) {
    return {
      Program() {
        const shebang = context.sourceCode
          .getAllComments()
          .find((comment) => comment.type === "Shebang");
        if (shebang !== undefined) {
          context.report({ loc: shebang.loc, messageId: "shebang" });
        }
      },
    };
  },
});
