import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  effectModuleOperation,
  resolvedVariable,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const NAMED_RECOVERY_MODULES = ["Effect", "Stream", "Channel"] as const;

const constantValue = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  seen: ReadonlySet<ESTree.Node> = new Set(),
): ESTree.Node => {
  const expression = unwrappedExpression(node);
  const definitions = resolvedVariable(expression, sourceCode)?.defs ?? [];
  const declarator = definitions.length === 1 ? definitions[0]?.node : undefined;
  const isConstantDeclarator =
    declarator?.type === "VariableDeclarator" &&
    declarator.id.type === "Identifier" &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    !seen.has(expression);
  const value = isConstantDeclarator ? declarator.init : null;
  return value === null
    ? expression
    : constantValue(value, sourceCode, new Set([...seen, expression]));
};

const isTagText = (node: ESTree.Node) =>
  (node.type === "Literal" && typeof node.value === "string") || node.type === "TemplateLiteral";

const isTagList = (node: ESTree.Node) => isTagText(node) || node.type === "ArrayExpression";

const isHandlerObject = (node: ESTree.Node) => node.type === "ObjectExpression";

const NAMED_RECOVERIES: ReadonlyMap<
  string,
  { readonly arity: number; readonly isNamingArgument: (node: ESTree.Node) => boolean }
> = new Map([
  ["catchTag", { arity: 2, isNamingArgument: isTagList }],
  ["catchTags", { arity: 1, isNamingArgument: isHandlerObject }],
  ["catchReason", { arity: 3, isNamingArgument: isTagText }],
  ["catchReasons", { arity: 2, isNamingArgument: isTagText }],
]);

const namesFailures = (
  isNamingArgument: (node: ESTree.Node) => boolean,
  argument: ESTree.Node | undefined,
  sourceCode: SourceCode,
) => argument !== undefined && isNamingArgument(constantValue(argument, sourceCode));

const hasFallback = (
  call: ESTree.CallExpression,
  recovery: {
    readonly arity: number;
    readonly isNamingArgument: (node: ESTree.Node) => boolean;
  },
  sourceCode: SourceCode,
) => {
  const { arguments: callArguments } = call;
  const hasSpread = callArguments.some((argument) => argument.type === "SpreadElement");
  if (hasSpread) {
    return true;
  }
  if (callArguments.length <= recovery.arity) {
    return false;
  }
  const isFallbackAfterTheSelf = callArguments.length > recovery.arity + 1;
  if (isFallbackAfterTheSelf) {
    return true;
  }
  const isDataLastWithFallback = namesFailures(
    recovery.isNamingArgument,
    callArguments[0],
    sourceCode,
  );
  const isDataFirstWithoutFallback = namesFailures(
    recovery.isNamingArgument,
    callArguments[1],
    sourceCode,
  );
  return isDataLastWithFallback || !isDataFirstWithoutFallback;
};

export const noUnnamedFallbacks = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Recover by name with catchTag, catchTags, catchReason and catchReasons without their fallback for every failure they do not name.",
    },
    messages: {
      fallback: "{{member}} is given a fallback for failures it does not name",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        for (const moduleName of NAMED_RECOVERY_MODULES) {
          const operation = effectModuleOperation(node.callee, context.sourceCode, moduleName);
          const recovery = operation === undefined ? undefined : NAMED_RECOVERIES.get(operation);
          const isFallbackGiven =
            recovery !== undefined && hasFallback(node, recovery, context.sourceCode);
          if (isFallbackGiven) {
            context.report({
              node,
              messageId: "fallback",
              data: { member: `${moduleName}.${operation}` },
            });
          }
        }
      },
    };
  },
});
