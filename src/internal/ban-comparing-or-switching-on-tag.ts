import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { importedExpression } from "./resolve-what-an-expression-imports.ts";

const COMPARISONS: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);

const isTagKey = (key: ESTree.Node, computed: boolean) =>
  computed
    ? key.type === "Literal" && key.value === "_tag"
    : (key.type === "Identifier" && key.name === "_tag") ||
      (key.type === "Literal" && key.value === "_tag");

const isTagRead = (node: ESTree.Node) =>
  node.type === "MemberExpression" && isTagKey(node.property, node.computed);

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
    docs: {
      description:
        "Disallow hand-written `_tag` values, except the reason tag Effect's PlatformError.systemError takes.",
    },
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

export const noTagBranching = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow comparing or switching on `_tag`." },
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

    return {
      BinaryExpression(node) {
        const comparesTag =
          COMPARISONS.has(node.operator) && (isTagRead(node.left) || isTagRead(node.right));
        if (comparesTag) {
          branch(node, "comparison");
        }
      },
      SwitchStatement(node) {
        if (isTagRead(node.discriminant)) {
          branch(node.discriminant, "switch");
        }
      },
    };
  },
});
