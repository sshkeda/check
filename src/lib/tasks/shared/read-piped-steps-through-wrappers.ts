import type { CallExpression, Node } from "typescript/unstable/ast";
import {
  isAsExpression,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
} from "typescript/unstable/ast/is";

const PIPE = "pipe";

const isWrapper = (node: Node) =>
  isParenthesizedExpression(node) ||
  isAsExpression(node) ||
  isSatisfiesExpression(node) ||
  isNonNullExpression(node);

export const withoutWrappers = (node: Node): Node =>
  isWrapper(node) ? withoutWrappers(node.expression) : node;

export const outermostWrapperOf = (node: Node): Node =>
  isWrapper(node.parent) ? outermostWrapperOf(node.parent) : node;

export const referencedNameOf = (node: Node) => {
  const reference = withoutWrappers(node);
  if (isPropertyAccessExpression(reference)) {
    return reference.name;
  }
  return isIdentifier(reference) ? reference : undefined;
};

export const pipedStepsOf = (call: CallExpression) => {
  if (referencedNameOf(call.expression)?.text !== PIPE) {
    return;
  }
  const callee = withoutWrappers(call.expression);
  return isPropertyAccessExpression(callee)
    ? [callee.expression, ...call.arguments]
    : [...call.arguments];
};
