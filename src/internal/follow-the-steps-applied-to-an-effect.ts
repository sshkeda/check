import type { ESTree, SourceCode } from "@oxlint/plugins";
import { Array as Arrays, Option } from "effect";

import {
  constantValue,
  effectOperation,
  isPipeFunction,
  memberName,
} from "./resolve-what-an-expression-imports.ts";

const PIPE = "pipe";

export const stepOf = (step: ESTree.Node, sourceCode: SourceCode) => {
  const node = constantValue(step, sourceCode);
  if (node.type === "CallExpression") {
    return {
      operation: effectOperation(node.callee, sourceCode),
      callArguments: node.arguments,
      isDataFirst: false,
    };
  }
  return { operation: effectOperation(node, sourceCode), callArguments: [], isDataFirst: false };
};

const stepsOf = (steps: readonly ESTree.Node[], sourceCode: SourceCode) =>
  steps.map((step) => stepOf(step, sourceCode));

const isPipeMethodCall = (call: ESTree.Node | null | undefined) =>
  call?.type === "CallExpression" &&
  call.callee.type === "MemberExpression" &&
  memberName(call.callee) === PIPE;

export const stepsAppliedTo = (
  effect: ESTree.Node,
  sourceCode: SourceCode,
): readonly ReturnType<typeof stepOf>[] => {
  const { parent } = effect;
  const isWrappedByTypeScript =
    parent?.type === "TSAsExpression" ||
    parent?.type === "TSSatisfiesExpression" ||
    parent?.type === "TSNonNullExpression";
  if (isWrappedByTypeScript) {
    return stepsAppliedTo(parent, sourceCode);
  }
  const call = parent?.parent;
  const isPipeMethod =
    parent?.type === "MemberExpression" &&
    parent.object === effect &&
    call?.type === "CallExpression" &&
    call.callee === parent &&
    isPipeMethodCall(call);
  if (isPipeMethod) {
    return [...stepsOf(call.arguments, sourceCode), ...stepsAppliedTo(call, sourceCode)];
  }
  const isFirstArgument = parent?.type === "CallExpression" && parent.arguments[0] === effect;
  if (!isFirstArgument) {
    return [];
  }
  const isAppliedStep =
    constantValue(parent.callee, sourceCode).type === "CallExpression" &&
    parent.arguments.length === 1;
  if (isAppliedStep) {
    return [stepOf(parent.callee, sourceCode), ...stepsAppliedTo(parent, sourceCode)];
  }
  if (isPipeFunction(parent.callee, sourceCode)) {
    return [
      ...stepsOf(parent.arguments.slice(1), sourceCode),
      ...stepsAppliedTo(parent, sourceCode),
    ];
  }
  return [
    {
      operation: effectOperation(parent.callee, sourceCode),
      callArguments: parent.arguments.slice(1),
      isDataFirst: true,
    },
    ...stepsAppliedTo(parent, sourceCode),
  ];
};

export const stepsAfter = (step: ESTree.Node, sourceCode: SourceCode) => {
  const { parent } = step;
  if (parent?.type !== "CallExpression") {
    return [];
  }
  const position = Option.getOrUndefined(
    Arrays.findFirstIndex(parent.arguments, (argument) => argument === step),
  );
  if (position === undefined) {
    return [];
  }
  const isPipeStep =
    isPipeMethodCall(parent) || (position > 0 && isPipeFunction(parent.callee, sourceCode));
  return isPipeStep
    ? [
        ...stepsOf(parent.arguments.slice(position + 1), sourceCode),
        ...stepsAppliedTo(parent, sourceCode),
      ]
    : [];
};
