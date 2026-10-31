import type { ESTree, SourceCode } from "@oxlint/plugins";

import { effectModuleOperation, resolvedVariable } from "./resolve-what-an-expression-imports.ts";

export const SERVICE_FACTORIES = new Set(["Service", "Reference"]);

const isVariableReference = (node: ESTree.Node, sourceCode: SourceCode) =>
  resolvedVariable(node, sourceCode)?.references.some(({ identifier }) => identifier === node) ===
  true;

export const serviceFactoryOf = (node: ESTree.Node, sourceCode: SourceCode) => {
  const isMemberOrVariableReference =
    node.type === "MemberExpression" || isVariableReference(node, sourceCode);
  if (!isMemberOrVariableReference) {
    return;
  }
  const factory = effectModuleOperation(node, sourceCode, "Context");
  const isServiceFactory = factory !== undefined && SERVICE_FACTORIES.has(factory);
  return isServiceFactory ? factory : undefined;
};
