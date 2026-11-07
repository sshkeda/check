import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  importedExpression,
  isGlobalReference,
  memberName,
  resolvedVariable,
} from "./resolve-what-an-expression-imports.ts";

const COMPARISONS: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);
const SAME_VALUE = "is";
const MEMBERSHIP = "includes";

const isTagKey = (key: ESTree.Node, computed: boolean) =>
  computed
    ? key.type === "Literal" && key.value === "_tag"
    : (key.type === "Identifier" && key.name === "_tag") ||
      (key.type === "Literal" && key.value === "_tag");

const isTagRead = (node: ESTree.Node): boolean =>
  node.type === "ChainExpression"
    ? isTagRead(node.expression)
    : node.type === "MemberExpression" && isTagKey(node.property, node.computed);

const memberOf = (node: ESTree.Node, owner: string) => {
  const isNamedMemberOfOwner =
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === owner &&
    node.property.type === "Identifier";
  return isNamedMemberOfOwner ? node.property.name : null;
};

const isEffectCatch = (node: ESTree.Node) =>
  node.type === "CallExpression" && (memberOf(node.callee, "Effect")?.startsWith("catch") ?? false);

const insideEffectCatch = (node: ESTree.Node): boolean =>
  node.parent === null ? false : isEffectCatch(node.parent) || insideEffectCatch(node.parent);

const isMatchPattern = (node: ESTree.Node) =>
  node.parent?.type === "CallExpression" && memberOf(node.parent.callee, "Match") !== null;

const isPlatformSystemErrorOptions = (node: ESTree.Node, sourceCode: SourceCode) => {
  const call = node.parent;
  if (call?.type !== "CallExpression") {
    return false;
  }
  if (call.arguments[0] !== node) {
    return false;
  }
  const imported = importedExpression(call.callee, sourceCode);
  return (
    imported !== undefined &&
    ((imported.module === "effect" && imported.members.join(".") === "PlatformError.systemError") ||
      (imported.module === "effect/PlatformError" && imported.members.join(".") === "systemError"))
  );
};

export const noManualTag = defineRule({
  meta: {
    type: "problem",
    messages: {
      construction: "`_tag` is written by hand",
    },
  },
  create(context) {
    return {
      ObjectExpression(node) {
        if (isMatchPattern(node)) {
          return;
        }
        if (isPlatformSystemErrorOptions(node, context.sourceCode)) {
          return;
        }
        for (const property of node.properties) {
          const writesTagByHand =
            property.type === "Property" && isTagKey(property.key, property.computed);
          if (writesTagByHand) {
            context.report({ node: property, messageId: "construction" });
          }
        }
      },
    };
  },
});

const isDestructuredTag = (node: ESTree.Node, sourceCode: SourceCode) => {
  const variable = resolvedVariable(node, sourceCode);
  if (variable?.references.some((reference) => reference.isWrite() && !reference.init) === true) {
    return false;
  }
  const binding = variable?.defs[0]?.name;
  const value = binding?.parent.type === "AssignmentPattern" ? binding.parent : binding;
  const property = value?.parent;
  return (
    property?.type === "Property" &&
    property.value === value &&
    property.parent.type === "ObjectPattern" &&
    isTagKey(property.key, property.computed)
  );
};

export const noTagBranching = defineRule({
  meta: {
    type: "problem",
    messages: {
      comparison: "`_tag` is compared",
      switch: "`_tag` is switched on",
      catchTag: "`_tag` is branched on inside an Effect catch",
    },
  },
  create(context) {
    const branch = (node: ESTree.Node, messageId: "comparison" | "switch") => {
      context.report({ node, messageId: insideEffectCatch(node) ? "catchTag" : messageId });
    };
    const readsTag = (node: ESTree.Node) =>
      isTagRead(node) || isDestructuredTag(node, context.sourceCode);

    return {
      BinaryExpression(node) {
        const comparesTag =
          COMPARISONS.has(node.operator) && (readsTag(node.left) || readsTag(node.right));
        if (comparesTag) {
          branch(node, "comparison");
        }
      },
      SwitchStatement(node) {
        if (readsTag(node.discriminant)) {
          branch(node.discriminant, "switch");
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression") {
          return;
        }
        const method = memberName(callee);
        const [first, second] = node.arguments;
        const isSameValueCheckOnTag =
          method === SAME_VALUE &&
          isGlobalReference(callee.object, context.sourceCode, "Object") &&
          [first, second].some((argument) => argument !== undefined && readsTag(argument));
        const isMembershipCheckOfTag =
          method === MEMBERSHIP && first !== undefined && readsTag(first);
        const comparesTag = isSameValueCheckOnTag || isMembershipCheckOfTag;
        if (comparesTag) {
          branch(node, "comparison");
        }
      },
    };
  },
});
