import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { effectModuleOperation, propertyKeyName } from "./resolve-what-an-expression-imports.ts";

const COLLECTING_OPERATION = "all";
const MODE = "mode";
const DEFAULT_MODE = "default";

const unsafeOptionsMessage = (options: ESTree.Node | undefined) => {
  if (options === undefined) {
    return;
  }
  if (options.type !== "ObjectExpression") {
    return "opaqueOptions";
  }
  const hasKeyItCannotName = options.properties.some(
    (property) => property.type === "SpreadElement" || propertyKeyName(property) === undefined,
  );
  if (hasKeyItCannotName) {
    return "opaqueOptions";
  }
  const mode = options.properties.find((property) => propertyKeyName(property) === MODE);
  if (mode?.type !== "Property") {
    return;
  }
  const isDefaultMode = mode.value.type === "Literal" && mode.value.value === DEFAULT_MODE;
  return isDefaultMode ? undefined : "results";
};

export const noFailuresAsResults = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Let Effect.all fail on the first failure, and collect failures as results only in files allowed handlesEveryFailure.",
    },
    messages: {
      results: "Effect.all turns each failure into a result",
      opaqueOptions: "Effect.all is given options that are not written inline",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const operation = effectModuleOperation(node.callee, context.sourceCode, "Effect");
        if (operation !== COLLECTING_OPERATION) {
          return;
        }
        const messageId = unsafeOptionsMessage(node.arguments[1]);
        if (messageId !== undefined) {
          context.report({ node: node.arguments[1] ?? node, messageId });
        }
      },
    };
  },
});
