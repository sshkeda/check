import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  importedExpression,
  isGlobalReference,
  memberName,
  resolvedVariable,
} from "./resolve-what-an-expression-imports.ts";

const SCANNING_METHODS = new Set(["scan", "scanSync"]);

const isBunNamespace = (node: ESTree.Node, sourceCode: SourceCode) => {
  if (isGlobalReference(node, sourceCode, "Bun")) {
    return true;
  }
  const definition = resolvedVariable(node, sourceCode)?.defs[0]?.node;
  return (
    (definition?.type === "ImportDefaultSpecifier" ||
      definition?.type === "ImportNamespaceSpecifier") &&
    definition.parent.type === "ImportDeclaration" &&
    definition.parent.source.value === "bun"
  );
};

const isGlobConstructor = (node: ESTree.Node, sourceCode: SourceCode): boolean => {
  if (node.type === "MemberExpression") {
    return memberName(node) === "Glob" && isBunNamespace(node.object, sourceCode);
  }
  const imported = importedExpression(node, sourceCode);
  return imported?.module === "bun" && imported.members.join(".") === "Glob";
};

const isGlobInstance = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  followedDeclarators: ReadonlySet<ESTree.Node> = new Set(),
): boolean => {
  if (node.type === "NewExpression") {
    return isGlobConstructor(node.callee, sourceCode);
  }
  if (node.type !== "Identifier") {
    return false;
  }
  const definition = resolvedVariable(node, sourceCode)?.defs[0]?.node;
  return (
    definition?.type === "VariableDeclarator" &&
    !followedDeclarators.has(definition) &&
    definition.id.type === "Identifier" &&
    definition.init !== null &&
    isGlobInstance(definition.init, sourceCode, new Set([...followedDeclarators, definition]))
  );
};

export const noGlobScan = defineRule({
  meta: {
    type: "problem",
    messages: {
      scan: "Bun.Glob {{method}} scans directories",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const method = memberName(node);
        const isScanOnGlobInstance =
          method !== undefined &&
          SCANNING_METHODS.has(method) &&
          isGlobInstance(node.object, context.sourceCode);
        if (isScanOnGlobInstance) {
          context.report({ node, messageId: "scan", data: { method } });
        }
      },
    };
  },
});
