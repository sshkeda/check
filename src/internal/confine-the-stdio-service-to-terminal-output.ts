import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  effectOperation,
  importedExpression,
  isImportBinding,
  isReferencePosition,
  memberName,
  propertyKeyName,
} from "./resolve-what-an-expression-imports.ts";

const MEMBERS_THAT_WRITE_NOTHING = new Set([
  "args",
  "stdin",
  "stdinIsTerminal",
  "stdoutIsTerminal",
  "stderrIsTerminal",
]);

const SERVICE_USE = "use";

const PIPE = "pipe";

const OPERATIONS_THAT_PASS_THE_SERVICE = new Set(["map", "flatMap", "andThen"]);

const rootOf = (node: ESTree.Node): ESTree.Node =>
  node.type === "MemberExpression" ? rootOf(node.object) : node;

const isStdioTag = (node: ESTree.Node, sourceCode: SourceCode) => {
  if (!isImportBinding(rootOf(node), sourceCode)) {
    return false;
  }
  const imported = importedExpression(node, sourceCode);
  const path = imported?.members.join(".");
  return (
    (imported?.module === "effect" && path === "Stdio.Stdio") ||
    (imported?.module === "effect/Stdio" && path === "Stdio")
  );
};

const readsOnlyMembersThatWriteNothing = (node: ESTree.Node) => {
  const { parent } = node;
  const isReadOfAMember = parent?.type === "MemberExpression" && parent.object === node;
  const member = isReadOfAMember ? memberName(parent) : undefined;
  return member !== undefined && MEMBERS_THAT_WRITE_NOTHING.has(member);
};

const patternReadsOnlyMembersThatWriteNothing = (properties: readonly ESTree.Node[]) =>
  properties.every((property) => {
    const key = propertyKeyName(property);
    return key !== undefined && MEMBERS_THAT_WRITE_NOTHING.has(key);
  });

const bindingReadsOnlyMembersThatWriteNothing = (
  binding: ESTree.Node | undefined,
  sourceCode: SourceCode,
) => {
  if (binding === undefined) {
    return true;
  }
  if (binding.type === "ObjectPattern") {
    return patternReadsOnlyMembersThatWriteNothing(binding.properties);
  }
  if (binding.type !== "Identifier") {
    return false;
  }
  const declared = sourceCode
    .getDeclaredVariables(binding.parent)
    .find((variable) => variable.identifiers.includes(binding));
  return (declared?.references ?? [])
    .filter((reference) => reference.identifier !== binding)
    .every((reference) => readsOnlyMembersThatWriteNothing(reference.identifier));
};

const serviceValueWritesNothing = (service: ESTree.Node, sourceCode: SourceCode) => {
  if (readsOnlyMembersThatWriteNothing(service)) {
    return true;
  }
  const declarator = service.parent;
  const isConstantInitializer =
    declarator?.type === "VariableDeclarator" &&
    declarator.init === service &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const";
  return (
    isConstantInitializer && bindingReadsOnlyMembersThatWriteNothing(declarator.id, sourceCode)
  );
};

const callbackWritesNothing = (callback: ESTree.Node | undefined, sourceCode: SourceCode) => {
  const isInline =
    callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression";
  if (isInline) {
    return bindingReadsOnlyMembersThatWriteNothing(callback.params[0], sourceCode);
  }
  return false;
};

const stepWritesNothing = (step: ESTree.Node | undefined, sourceCode: SourceCode) => {
  const isOneArgumentCall = step?.type === "CallExpression" && step.arguments.length === 1;
  if (!isOneArgumentCall) {
    return false;
  }
  const operation = effectOperation(step.callee, sourceCode);
  const passesTheServiceOn =
    operation !== undefined && OPERATIONS_THAT_PASS_THE_SERVICE.has(operation);
  return passesTheServiceOn && callbackWritesNothing(step.arguments[0], sourceCode);
};

const isPipeFunction = (callee: ESTree.Node, sourceCode: SourceCode) => {
  const imported = importedExpression(callee, sourceCode);
  const path = imported?.members.join(".");
  const isFromEffect =
    imported?.module === "effect" && (path === PIPE || path === `Function.${PIPE}`);
  const isFromFunction = imported?.module === "effect/Function" && path === PIPE;
  return isFromEffect || isFromFunction;
};

const tagUseWritesNothing = (tag: ESTree.Node, sourceCode: SourceCode) => {
  const { parent } = tag;
  const isYielded =
    parent?.type === "YieldExpression" && parent.delegate && parent.argument === tag;
  if (isYielded) {
    return serviceValueWritesNothing(parent, sourceCode);
  }
  const call = parent?.parent;
  const isMethodCall =
    parent?.type === "MemberExpression" &&
    parent.object === tag &&
    call?.type === "CallExpression" &&
    call.callee === parent;
  if (isMethodCall) {
    const method = memberName(parent);
    if (method === SERVICE_USE) {
      return callbackWritesNothing(call.arguments[0], sourceCode);
    }
    return method === PIPE && stepWritesNothing(call.arguments[0], sourceCode);
  }
  const isCallOnTheTag = parent?.type === "CallExpression" && parent.arguments[0] === tag;
  if (!isCallOnTheTag) {
    return false;
  }
  if (isPipeFunction(parent.callee, sourceCode)) {
    return stepWritesNothing(parent.arguments[1], sourceCode);
  }
  const operation = effectOperation(parent.callee, sourceCode);
  const passesTheServiceOn =
    operation !== undefined && OPERATIONS_THAT_PASS_THE_SERVICE.has(operation);
  return passesTheServiceOn && callbackWritesNothing(parent.arguments[1], sourceCode);
};

export const noStdioService = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Use the Effect Stdio service only in files allowed writesToTheTerminal, except to read stdin, args or whether a stream is a terminal.",
    },
    messages: {
      stdioService:
        "{{usage}} is used for more than reading stdin, args or whether a stream is a terminal",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const check = (node: ESTree.Node) => {
      const isRefusedTagUse =
        isStdioTag(node, sourceCode) && !tagUseWritesNothing(node, sourceCode);
      if (isRefusedTagUse) {
        context.report({
          node,
          messageId: "stdioService",
          data: { usage: sourceCode.getText(node) },
        });
      }
    };
    return {
      Identifier(node) {
        const isValueReference =
          isReferencePosition(node) ||
          (node.parent.type === "MemberExpression" && node.parent.object === node);
        if (isValueReference) {
          check(node);
        }
      },
      MemberExpression: check,
    };
  },
});
