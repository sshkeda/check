import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  constantValue,
  effectModuleOperation,
  isAssignmentTarget,
  resolvedVariable,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const EFFECT_MODULES_THAT_RUN_CALLBACKS = [
  "Effect",
  "Stream",
  "Layer",
  "Schedule",
  "Sink",
  "Channel",
] as const;

const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSInstantiationExpression",
  "TSTypeAssertion",
]);

const enclosingFunctionOf = (node: ESTree.Node): ESTree.Node | null => {
  const { parent } = node;
  if (parent === null) {
    return null;
  }
  return FUNCTION_TYPES.has(parent.type) ? parent : enclosingFunctionOf(parent);
};

const outermostWrapperOf = (node: ESTree.Node): ESTree.Node => {
  const { parent } = node;
  const isWrapped =
    parent !== null &&
    TRANSPARENT_WRAPPERS.has(parent.type) &&
    "expression" in parent &&
    parent.expression === node;
  return isWrapped ? outermostWrapperOf(parent) : node;
};

const rootObjectOf = (node: ESTree.Node): ESTree.Node => {
  const unwrapped = unwrappedExpression(node);
  const inner = unwrapped.type === "ChainExpression" ? unwrapped.expression : unwrapped;
  return inner.type === "MemberExpression" ? rootObjectOf(inner.object) : inner;
};

const isWritten = (member: ESTree.MemberExpression) => {
  const target = outermostWrapperOf(member);
  const { parent } = target;
  const isDeleted = parent?.type === "UnaryExpression" && parent.operator === "delete";
  return isDeleted || parent?.type === "UpdateExpression" || isAssignmentTarget(target);
};

const CURRIED_EFFECT_FUNCTIONS: ReadonlySet<string> = new Set(["Effect.fn", "Effect.fnUntraced"]);

const LAYER_PREFIX = "Layer.";

const CONTEXT_RUNNER_SUFFIX = "With";

const PREDICATE = /^is[A-Z]/u;

const effectOperationNamed = (callee: ESTree.Node, sourceCode: SourceCode) =>
  EFFECT_MODULES_THAT_RUN_CALLBACKS.flatMap((moduleName) => {
    const operation = effectModuleOperation(callee, sourceCode, moduleName);
    return operation === undefined ? [] : [`${moduleName}.${operation}`];
  }).at(0);

const effectOperationOf = (callee: ESTree.Node, sourceCode: SourceCode): string | undefined => {
  const called = unwrappedExpression(callee);
  if (called.type === "CallExpression") {
    const curried = effectOperationNamed(called.callee, sourceCode);
    const isCurriedEffectFunction =
      curried !== undefined &&
      (CURRIED_EFFECT_FUNCTIONS.has(curried) ||
        curried.startsWith(LAYER_PREFIX) ||
        curried.endsWith(CONTEXT_RUNNER_SUFFIX));
    return isCurriedEffectFunction ? curried : undefined;
  }
  const operation = effectOperationNamed(called, sourceCode);
  const name = operation?.split(".").at(-1) ?? "";
  const isPredicate = PREDICATE.test(name);
  return isPredicate ? undefined : operation;
};

const callReceiving = (callback: ESTree.Node): ESTree.CallExpression | undefined => {
  const argument = outermostWrapperOf(callback);
  const { parent } = argument;
  if (parent === null) {
    return undefined;
  }
  const isArgument =
    parent.type === "CallExpression" &&
    parent.arguments.some((candidate) => candidate === argument);
  if (isArgument) {
    return parent;
  }
  const isOptionValue =
    parent.type === "Property" &&
    parent.value === argument &&
    parent.parent.type === "ObjectExpression";
  return isOptionValue ? callReceiving(parent.parent) : undefined;
};

const namedReferencesOf = (callback: ESTree.Node, sourceCode: SourceCode) => {
  const declarator =
    callback.type === "FunctionDeclaration" ? callback : outermostWrapperOf(callback).parent;
  const isDeclaration =
    declarator?.type === "FunctionDeclaration" || declarator?.type === "VariableDeclarator";
  const binding = isDeclaration ? declarator.id : null;
  const isNamedConst =
    declarator?.type === "VariableDeclarator" &&
    declarator.id.type === "Identifier" &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const";
  const isNamedFunction = declarator?.type === "FunctionDeclaration";
  const isNamedCallback = (isNamedConst || isNamedFunction) && binding?.type === "Identifier";
  if (!isNamedCallback) {
    return [];
  }
  const variable = sourceCode
    .getDeclaredVariables(declarator)
    .find((candidate) => candidate.identifiers.includes(binding));
  return (variable?.references ?? [])
    .map(({ identifier }) => identifier)
    .filter(
      (identifier) =>
        identifier !== binding &&
        (!isNamedFunction || constantValue(identifier, sourceCode) === callback),
    );
};

const effectOperationRunning = (
  write: ESTree.Node,
  declarer: ESTree.Node | null,
  sourceCode: SourceCode,
): string | undefined => {
  const writer = enclosingFunctionOf(write);
  const isOutsideEveryCapturingFunction = writer === null || writer === declarer;
  if (isOutsideEveryCapturingFunction) {
    return undefined;
  }
  const operation = [writer, ...namedReferencesOf(writer, sourceCode)]
    .map((callback) => callReceiving(callback))
    .flatMap((call) => (call === undefined ? [] : [effectOperationOf(call.callee, sourceCode)]))
    .find((found) => found !== undefined);
  return operation ?? effectOperationRunning(writer, declarer, sourceCode);
};

export const noSharedHolders = defineRule({
  meta: {
    type: "problem",
    messages: {
      captured:
        "{{name}} is written inside a function passed to {{operation}}, which can run it concurrently or later; hold that state in a Ref",
    },
  },
  create(context) {
    const reported = new Set<ESTree.Node>();
    return {
      MemberExpression(member) {
        const isOutermostMember = outermostWrapperOf(member).parent?.type !== "MemberExpression";
        const isWrittenMember = isOutermostMember && isWritten(member);
        if (!isWrittenMember) {
          return;
        }
        const root = rootObjectOf(member);
        const declaration = resolvedVariable(root, context.sourceCode)?.defs[0];
        const declarator = declaration?.node;
        const isConstObjectLiteral =
          declarator?.type === "VariableDeclarator" &&
          declarator.id.type === "Identifier" &&
          declarator.init !== null &&
          unwrappedExpression(declarator.init).type === "ObjectExpression" &&
          declarator.parent.type === "VariableDeclaration" &&
          declarator.parent.kind === "const";
        const isUnreportedObjectLiteral =
          isConstObjectLiteral && declaration !== undefined && !reported.has(declaration.name);
        if (!isUnreportedObjectLiteral) {
          return;
        }
        const operation = effectOperationRunning(
          member,
          enclosingFunctionOf(declaration.name),
          context.sourceCode,
        );
        if (operation !== undefined) {
          reported.add(declaration.name);
          context.report({
            node: declaration.name,
            messageId: "captured",
            data: { name: root.type === "Identifier" ? root.name : "", operation },
          });
        }
      },
    };
  },
});
