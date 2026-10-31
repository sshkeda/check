import { defineRule } from "@oxlint/plugins";

export const noTypeDeclarations = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Derive types inline from the Schema or function that produces them instead of declaring type aliases, interfaces, enums, namespaces or ambient modules.",
    },
    messages: {
      typeAlias: "type {{name}} is declared",
      interface: "interface {{name}} is declared",
      enum: "enum {{name}} is declared",
      namespace: "{{keyword}} {{name}} is declared",
      ambient: "declare {{name}} is declared",
    },
  },
  create(context) {
    return {
      TSTypeAliasDeclaration(node) {
        context.report({ node: node.id, messageId: "typeAlias", data: { name: node.id.name } });
      },
      TSInterfaceDeclaration(node) {
        context.report({ node: node.id, messageId: "interface", data: { name: node.id.name } });
      },
      TSEnumDeclaration(node) {
        context.report({ node: node.id, messageId: "enum", data: { name: node.id.name } });
      },
      TSModuleDeclaration(node) {
        const name = context.sourceCode.getText(node.id);
        const isAmbientModule = node.kind === "global" || node.id.type === "Literal";
        if (isAmbientModule) {
          context.report({
            node,
            messageId: "ambient",
            data: { name: node.kind === "global" ? name : `module ${name}` },
          });
          return;
        }
        context.report({
          node: node.id,
          messageId: "namespace",
          data: { keyword: node.kind, name },
        });
      },
    };
  },
});
