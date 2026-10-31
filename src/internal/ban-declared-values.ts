import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const DECLARATION_FILE = /\.d(?:\.[^./]+)?\.[cm]?ts$/u;

const isInsideAnAmbientBlock = (node: ESTree.Node): boolean => {
  const { parent } = node;
  if (parent === null) {
    return false;
  }
  const isAmbientBlock =
    parent.type === "TSModuleDeclaration" && (parent.declare || parent.kind === "global");
  return isAmbientBlock || isInsideAnAmbientBlock(parent);
};

const propertyName = (key: ESTree.Node) => {
  const isNamedKey = key.type === "Identifier" || key.type === "PrivateIdentifier";
  if (isNamedKey) {
    return key.name;
  }
  return key.type === "Literal" ? String(key.value) : undefined;
};

const bindingNames = (declaration: ESTree.VariableDeclaration) =>
  declaration.declarations
    .map(({ id }) => (id.type === "Identifier" ? id.name : "a destructured binding"))
    .join(", ");

export const noDeclaredValues = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Give every value and class field an implementation; anything declared with declare has a type nothing checks.",
    },
    messages: {
      declaredValue: "{{name}} is declared without an implementation",
    },
  },
  create(context) {
    const isDeclarationFile = DECLARATION_FILE.test(context.filename);
    const isAmbient = (node: ESTree.Node, declared: boolean | undefined) =>
      declared === true || isDeclarationFile || isInsideAnAmbientBlock(node);
    const report = (node: ESTree.Node, name: string) => {
      context.report({ node, messageId: "declaredValue", data: { name } });
    };
    return {
      VariableDeclaration(node) {
        if (isAmbient(node, node.declare)) {
          report(node, bindingNames(node));
        }
      },
      TSDeclareFunction(node) {
        if (isAmbient(node, node.declare)) {
          report(node, node.id?.name ?? "the default export");
        }
      },
      PropertyDefinition(node) {
        if (node.declare === true) {
          report(node, propertyName(node.key) ?? "a computed class field");
        }
      },
      ClassDeclaration(node) {
        if (isAmbient(node, node.declare)) {
          report(node, node.id?.name ?? "the default export");
        }
      },
    };
  },
});
