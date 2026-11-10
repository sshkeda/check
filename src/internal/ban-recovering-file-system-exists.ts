import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { stepsAppliedTo } from "./follow-the-steps-applied-to-an-effect.ts";
import {
  constantValue,
  effectOperation,
  importedExpression,
  memberName,
  propertyKeyName,
  resolvedVariable,
  returnedExpression,
  staticKeyName,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const EXISTS = "exists";

const PLATFORM_ERROR = "PlatformError";

const OPERATIONS_THAT_KEEP_THE_FAILURES = new Set(["map", "as"]);

const SUCCEEDING_OPERATIONS = new Set(["succeed", "succeedSome"]);

const SUCCEEDING_VALUES = new Set(["void", "succeedNone"]);

const isFileSystemTag = (node: ESTree.Node, sourceCode: SourceCode) => {
  const imported = importedExpression(node, sourceCode);
  const path = imported?.members.join(".");
  return (
    (imported?.module === "effect" && path === "FileSystem.FileSystem") ||
    (imported?.module === "effect/FileSystem" && path === "FileSystem")
  );
};

const isYieldedFileSystem = (node: ESTree.Node, sourceCode: SourceCode) => {
  const value = unwrappedExpression(node);
  return (
    value.type === "YieldExpression" &&
    value.delegate &&
    value.argument !== null &&
    isFileSystemTag(value.argument, sourceCode)
  );
};

const yieldedFileSystemBinding = (node: ESTree.Node, sourceCode: SourceCode) => {
  const definitions = resolvedVariable(node, sourceCode)?.defs ?? [];
  const declarator = definitions.length === 1 ? definitions[0]?.node : undefined;
  const isConstantDeclarator =
    declarator?.type === "VariableDeclarator" &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const";
  const initializer = isConstantDeclarator ? declarator.init : null;
  const binding = isConstantDeclarator ? declarator.id : undefined;
  if (initializer === null) {
    return;
  }
  return isYieldedFileSystem(initializer, sourceCode) ? binding : undefined;
};

const isFileSystemExists = (callee: ESTree.Node, sourceCode: SourceCode) => {
  const node = unwrappedExpression(callee);
  if (node.type === "MemberExpression") {
    if (memberName(node) !== EXISTS) {
      return false;
    }
    return (
      isYieldedFileSystem(node.object, sourceCode) ||
      yieldedFileSystemBinding(node.object, sourceCode)?.type === "Identifier"
    );
  }
  if (node.type !== "Identifier") {
    return false;
  }
  const pattern = yieldedFileSystemBinding(node, sourceCode);
  return (
    pattern?.type === "ObjectPattern" &&
    pattern.properties.some(
      (property) =>
        property.type === "Property" &&
        propertyKeyName(property) === EXISTS &&
        property.value.type === "Identifier" &&
        property.value.name === node.name,
    )
  );
};

const succeeds = (handler: ESTree.Node | undefined, sourceCode: SourceCode) => {
  const resolved = handler === undefined ? undefined : constantValue(handler, sourceCode);
  const handlerOperation =
    resolved === undefined ? undefined : effectOperation(resolved, sourceCode);
  if (handlerOperation !== undefined) {
    return SUCCEEDING_OPERATIONS.has(handlerOperation);
  }
  const returned = returnedExpression(resolved);
  if (returned === undefined) {
    return false;
  }
  const value = constantValue(returned, sourceCode);
  if (value.type === "CallExpression") {
    const operation = effectOperation(value.callee, sourceCode);
    return operation !== undefined && SUCCEEDING_OPERATIONS.has(operation);
  }
  const operation = effectOperation(value, sourceCode);
  return operation !== undefined && SUCCEEDING_VALUES.has(operation);
};

const namesPlatformError = (tags: ESTree.Node | undefined, sourceCode: SourceCode) => {
  if (tags === undefined) {
    return false;
  }
  const value = constantValue(tags, sourceCode);
  if (value.type === "ArrayExpression") {
    return value.elements.some(
      (element) =>
        element !== null && staticKeyName(constantValue(element, sourceCode)) === PLATFORM_ERROR,
    );
  }
  return staticKeyName(value) === PLATFORM_ERROR;
};

const effectivePlatformErrorHandler = (properties: readonly ESTree.Node[]) => {
  const last = properties.findLast(
    (property) =>
      property.type === "SpreadElement" ||
      propertyKeyName(property) === undefined ||
      propertyKeyName(property) === PLATFORM_ERROR,
  );
  if (last?.type !== "Property") {
    return;
  }
  return propertyKeyName(last) === PLATFORM_ERROR ? last.value : undefined;
};

const recoversPlatformErrorWithASuccess = (
  handlers: ESTree.Node | undefined,
  sourceCode: SourceCode,
) => {
  const value = handlers === undefined ? undefined : unwrappedExpression(handlers);
  return (
    value?.type === "ObjectExpression" &&
    succeeds(effectivePlatformErrorHandler(value.properties), sourceCode)
  );
};

const catchTagSwallows = (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) =>
  namesPlatformError(callArguments[0], sourceCode) && succeeds(callArguments[1], sourceCode);

const catchTagsSwallows = (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) =>
  recoversPlatformErrorWithASuccess(callArguments[0], sourceCode);

const handlerSwallows = (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) =>
  succeeds(callArguments[0], sourceCode);

const alwaysSwallows = () => true;

const RECOVERIES = new Map([
  ["catchTag", { arity: 2, swallows: catchTagSwallows }],
  ["catchTags", { arity: 1, swallows: catchTagsSwallows }],
  ["catch", { arity: 1, swallows: handlerSwallows }],
  ["catchEager", { arity: 1, swallows: handlerSwallows }],
  ["catchCause", { arity: 1, swallows: handlerSwallows }],
  ["orElse", { arity: 1, swallows: handlerSwallows }],
  ["orElseSucceed", { arity: 1, swallows: alwaysSwallows }],
  ["option", { arity: 0, swallows: alwaysSwallows }],
]);

const swallowingRecovery = (
  operation: string | undefined,
  callArguments: readonly ESTree.Node[],
  sourceCode: SourceCode,
) => {
  const recovery = operation === undefined ? undefined : RECOVERIES.get(operation);
  const isSpread = callArguments.some((argument) => argument.type === "SpreadElement");
  const isSwallowing =
    recovery !== undefined &&
    !isSpread &&
    callArguments.length >= recovery.arity &&
    recovery.swallows(callArguments, sourceCode);
  return isSwallowing ? operation : undefined;
};

const keepsTheFailures = (operation: string | undefined, callArguments: readonly ESTree.Node[]) =>
  operation !== undefined &&
  OPERATIONS_THAT_KEEP_THE_FAILURES.has(operation) &&
  callArguments.length === 1;

const recoveryAmongSteps = (
  steps: ReturnType<typeof stepsAppliedTo>,
  sourceCode: SourceCode,
): string | undefined => {
  const [step, ...rest] = steps;
  if (step === undefined) {
    return;
  }
  const { operation, callArguments, isDataFirst } = step;
  const isRecoveryShape =
    !isDataFirst ||
    (operation !== undefined && RECOVERIES.get(operation)?.arity === callArguments.length);
  const recovery = isRecoveryShape
    ? swallowingRecovery(operation, callArguments, sourceCode)
    : undefined;
  if (recovery !== undefined) {
    return recovery;
  }
  return keepsTheFailures(operation, callArguments)
    ? recoveryAmongSteps(rest, sourceCode)
    : undefined;
};

export const noExistsRecovery = defineRule({
  meta: {
    type: "problem",
    messages: {
      recovered:
        "Effect.{{recovery}} turns a real failure of exists into an answer; exists already answers false for a missing path",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        if (!isFileSystemExists(node.callee, sourceCode)) {
          return;
        }
        const recovery = recoveryAmongSteps(stepsAppliedTo(node, sourceCode), sourceCode);
        if (recovery !== undefined) {
          context.report({ node, messageId: "recovered", data: { recovery } });
        }
      },
    };
  },
});
