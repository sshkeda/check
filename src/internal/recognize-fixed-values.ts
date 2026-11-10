import type { ESTree, SourceCode } from "@oxlint/plugins";

import { stepOf } from "./follow-the-steps-applied-to-an-effect.ts";
import {
  constantValue,
  effectModuleOperation,
  importedExpression,
  isGlobalReference,
  isPipeFunction,
  memberName,
  resolvedVariable,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const PIPE = "pipe";

const EFFECT_MODULES = ["Effect", "Stream", "Channel"] as const;

const FIXED_EFFECTS: ReadonlySet<string> = new Set(["void", "succeedNone", "empty"]);

const SUCCEEDING_OPERATIONS: ReadonlySet<string> = new Set(["succeed", "succeedSome"]);

const SIGN_OPERATORS: ReadonlySet<string> = new Set(["-", "+", "void"]);

const CONSTRUCTED_GLOBALS = ["Map", "Set", "Date", "Uint8Array"] as const;

const PRIMITIVE_GLOBAL_CALLS = [
  { object: "Date", member: "now" },
  { object: "process", member: "cwd" },
] as const;

const GLOBAL_CALLS = [...PRIMITIVE_GLOBAL_CALLS, { object: "Uint8Array", member: "of" }] as const;

const MODULE_SCOPES: ReadonlySet<string> = new Set(["module", "global"]);

const OS_MODULES: ReadonlySet<string> = new Set(["node:os", "os"]);

const HOME_DIRECTORY = "homedir";

const CURRENT_TIME = [
  { moduleName: "Clock", member: "currentTimeMillis" },
  { moduleName: "DateTime", member: "now" },
] as const;

const branchesOf = (expression: ESTree.Node): readonly ESTree.Node[] => {
  const value = unwrappedExpression(expression);
  if (value.type === "ConditionalExpression") {
    return [...branchesOf(value.consequent), ...branchesOf(value.alternate)];
  }
  if (value.type === "SequenceExpression") {
    const last = value.expressions.at(-1);
    return last === undefined ? [] : branchesOf(last);
  }
  return [value];
};

export const returnedValuesIn = (statement: ESTree.Node | null): readonly ESTree.Node[] => {
  if (statement === null) {
    return [];
  }
  if (statement.type === "ReturnStatement") {
    return statement.argument === null ? [] : branchesOf(statement.argument);
  }
  if (statement.type === "BlockStatement") {
    return statement.body.flatMap((inner) => returnedValuesIn(inner));
  }
  if (statement.type === "IfStatement") {
    return [...returnedValuesIn(statement.consequent), ...returnedValuesIn(statement.alternate)];
  }
  if (statement.type === "TryStatement") {
    return [
      ...returnedValuesIn(statement.block),
      ...returnedValuesIn(statement.handler?.body ?? null),
    ];
  }
  if (statement.type === "SwitchStatement") {
    return statement.cases.flatMap((switchCase) =>
      switchCase.consequent.flatMap((inner) => returnedValuesIn(inner)),
    );
  }
  return statement.type === "LabeledStatement" ? returnedValuesIn(statement.body) : [];
};

const FUNCTION_WRAPPERS: ReadonlySet<string> = new Set(["fn", "fnUntraced"]);

const isFunctionWrapper = (callee: ESTree.Node, sourceCode: SourceCode) => {
  const operation = effectModuleOperation(callee, sourceCode, "Effect");
  return operation !== undefined && FUNCTION_WRAPPERS.has(operation);
};

const wrappedFunction = (call: ESTree.CallExpression, sourceCode: SourceCode) => {
  const isNamedWrapper =
    call.callee.type === "CallExpression" && isFunctionWrapper(call.callee.callee, sourceCode);
  const isWrapped = isNamedWrapper || isFunctionWrapper(call.callee, sourceCode);
  const [wrapped] = call.arguments;
  const isWrappingAFunction = isWrapped && wrapped !== undefined;
  return isWrappingAFunction ? constantValue(wrapped, sourceCode) : undefined;
};

export const handlerFunction = (handler: ESTree.Node, sourceCode: SourceCode) => {
  const resolved = constantValue(handler, sourceCode);
  const unwrapped =
    resolved.type === "CallExpression" ? wrappedFunction(resolved, sourceCode) : resolved;
  const isFunction =
    unwrapped?.type === "ArrowFunctionExpression" ||
    unwrapped?.type === "FunctionExpression" ||
    unwrapped?.type === "FunctionDeclaration";
  return isFunction ? unwrapped : undefined;
};

export const returnedBranches = (handler: ESTree.Node, sourceCode: SourceCode) => {
  const body = handlerFunction(handler, sourceCode)?.body ?? null;
  if (body === null) {
    return [];
  }
  return body.type === "BlockStatement" ? returnedValuesIn(body) : branchesOf(body);
};

const isGlobalCall = (
  callee: ESTree.Node,
  sourceCode: SourceCode,
  calls: readonly { readonly object: string; readonly member: string }[] = GLOBAL_CALLS,
) =>
  callee.type === "MemberExpression" &&
  calls.some(
    ({ object, member }) =>
      memberName(callee) === member && isGlobalReference(callee.object, sourceCode, object),
  );

const isHomeDirectoryCall = (callee: ESTree.Node, sourceCode: SourceCode) => {
  const imported = importedExpression(callee, sourceCode);
  return (
    imported !== undefined &&
    OS_MODULES.has(imported.module) &&
    imported.members.at(-1) === HOME_DIRECTORY
  );
};

const isFixedOptionOrResult = (call: ESTree.CallExpression, sourceCode: SourceCode) => {
  const optionOperation = effectModuleOperation(call.callee, sourceCode, "Option");
  const resultOperation = effectModuleOperation(call.callee, sourceCode, "Result");
  const isNone = optionOperation === "none" && call.arguments.length === 0;
  const wrapsOneValue =
    (optionOperation === "some" || resultOperation === "succeed") && call.arguments.length === 1;
  return isNone || wrapsOneValue;
};

const isImmutableByNature = (value: ESTree.Node, sourceCode: SourceCode): boolean => {
  if (value.type === "Literal") {
    return typeof value.value !== "object" || value.value === null;
  }
  if (value.type === "TemplateLiteral") {
    return value.expressions.length === 0;
  }
  if (value.type === "Identifier") {
    return isGlobalReference(value, sourceCode, "undefined");
  }
  if (value.type === "UnaryExpression") {
    return (
      SIGN_OPERATORS.has(value.operator) &&
      isImmutableByNature(constantValue(value.argument, sourceCode), sourceCode)
    );
  }
  if (value.type !== "CallExpression") {
    return false;
  }
  const isPrimitiveCall =
    isGlobalCall(value.callee, sourceCode, PRIMITIVE_GLOBAL_CALLS) ||
    isHomeDirectoryCall(value.callee, sourceCode);
  const isImmutableCall = isPrimitiveCall || isFixedOptionOrResult(value, sourceCode);
  return (
    isImmutableCall &&
    value.arguments.every(
      (argument) =>
        argument.type !== "SpreadElement" &&
        isImmutableByNature(constantValue(argument, sourceCode), sourceCode),
    )
  );
};

const valueOfAnUnchangeableBinding = (node: ESTree.Node, sourceCode: SourceCode) => {
  const value = constantValue(node, sourceCode);
  const variable = resolvedVariable(unwrappedExpression(node), sourceCode);
  const isDeclaredAtModuleScope =
    variable === undefined || MODULE_SCOPES.has(variable.scope.variableScope.type);
  const isResolvable = isDeclaredAtModuleScope || isImmutableByNature(value, sourceCode);
  return isResolvable ? value : unwrappedExpression(node);
};

export const isFixedValue = (node: ESTree.Node, sourceCode: SourceCode): boolean => {
  const value = valueOfAnUnchangeableBinding(node, sourceCode);
  const areFixedArguments = (callArguments: readonly ESTree.Node[]) =>
    callArguments.every(
      (argument) => argument.type !== "SpreadElement" && isFixedValue(argument, sourceCode),
    );
  const isFixedProperty = (property: ESTree.Node) =>
    property.type === "Property" &&
    !property.computed &&
    !property.method &&
    property.kind === "init" &&
    isFixedValue(property.value, sourceCode);
  if (value.type === "Literal") {
    return typeof value.value !== "object" || value.value === null;
  }
  if (value.type === "TemplateLiteral") {
    return value.expressions.length === 0;
  }
  if (value.type === "Identifier") {
    return isGlobalReference(value, sourceCode, "undefined");
  }
  if (value.type === "UnaryExpression") {
    return SIGN_OPERATORS.has(value.operator) && isFixedValue(value.argument, sourceCode);
  }
  if (value.type === "ArrayExpression") {
    return value.elements.every(
      (element) =>
        element !== null && element.type !== "SpreadElement" && isFixedValue(element, sourceCode),
    );
  }
  if (value.type === "ObjectExpression") {
    return value.properties.every((property) => isFixedProperty(property));
  }
  if (value.type === "NewExpression") {
    const isConstructedGlobal = CONSTRUCTED_GLOBALS.some((name) =>
      isGlobalReference(value.callee, sourceCode, name),
    );
    return isConstructedGlobal && areFixedArguments(value.arguments);
  }
  if (value.type !== "CallExpression") {
    return false;
  }
  const isFixedCall =
    isGlobalCall(value.callee, sourceCode) ||
    isHomeDirectoryCall(value.callee, sourceCode) ||
    isFixedOptionOrResult(value, sourceCode);
  return isFixedCall && areFixedArguments(value.arguments);
};

const isCurrentTime = (node: ESTree.Node, sourceCode: SourceCode) =>
  CURRENT_TIME.some(
    ({ moduleName, member }) => effectModuleOperation(node, sourceCode, moduleName) === member,
  );

const isFixedEffectMember = (node: ESTree.Node, sourceCode: SourceCode) =>
  isCurrentTime(node, sourceCode) ||
  EFFECT_MODULES.some((moduleName) => {
    const operation = effectModuleOperation(node, sourceCode, moduleName);
    return operation !== undefined && FIXED_EFFECTS.has(operation);
  });

const fixedValueAfterTheLastStep = (steps: readonly ESTree.Node[], sourceCode: SourceCode) => {
  const last = steps.at(-1);
  if (last === undefined) {
    return;
  }
  const { operation, callArguments } = stepOf(last, sourceCode);
  const [value] = callArguments;
  if (operation === "asVoid") {
    return callArguments.length === 0 ? last : undefined;
  }
  const isFixedReplacement =
    operation === "as" && value !== undefined && isFixedValue(value, sourceCode);
  return isFixedReplacement ? value : undefined;
};

const fixedReturnedValue = (
  callArguments: readonly ESTree.Node[],
  sourceCode: SourceCode,
): ESTree.Node | undefined =>
  callArguments
    .flatMap((argument) => returnedBranches(argument, sourceCode))
    .find((branch) => isFixedValue(branch, sourceCode));

const fixedValueOfEffectCall = (
  call: ESTree.CallExpression,
  sourceCode: SourceCode,
): ESTree.Node | undefined => {
  const { callee, arguments: callArguments } = call;
  const isPipeMethod = callee.type === "MemberExpression" && memberName(callee) === PIPE;
  if (isPipeMethod) {
    return fixedValueAfterTheLastStep(callArguments, sourceCode);
  }
  if (isPipeFunction(callee, sourceCode)) {
    return fixedValueAfterTheLastStep(callArguments.slice(1), sourceCode);
  }
  const operation = EFFECT_MODULES.map((moduleName) =>
    effectModuleOperation(callee, sourceCode, moduleName),
  ).find((found) => found !== undefined);
  const [first, second] = callArguments;
  if (operation === undefined) {
    return;
  }
  if (SUCCEEDING_OPERATIONS.has(operation)) {
    const isFixedSuccess =
      callArguments.length === 1 && first !== undefined && isFixedValue(first, sourceCode);
    return isFixedSuccess ? first : undefined;
  }
  if (operation === "as") {
    const isFixedReplacement = second !== undefined && isFixedValue(second, sourceCode);
    return isFixedReplacement ? second : undefined;
  }
  if (operation === "asVoid") {
    return callArguments.length === 1 ? call : undefined;
  }
  const computesItsValue = operation === "sync" || operation === "gen";
  return computesItsValue ? fixedReturnedValue(callArguments, sourceCode) : undefined;
};

export const fixedOutcomeOf = (node: ESTree.Node, sourceCode: SourceCode) => {
  if (isFixedValue(node, sourceCode)) {
    return node;
  }
  const value = constantValue(node, sourceCode);
  if (value.type === "CallExpression") {
    return fixedValueOfEffectCall(value, sourceCode);
  }
  return isFixedEffectMember(value, sourceCode) ? node : undefined;
};
