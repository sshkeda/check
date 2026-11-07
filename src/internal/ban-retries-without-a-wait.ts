import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  constantValue,
  effectModuleOperation,
  effectModuleReference,
  isGlobalReference,
  memberName,
  propertyKeyName,
  resolvedVariable,
  returnedExpression,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const RETRYING_MODULES = ["Effect", "Stream"] as const;
const RETRY = "retry";
const RETRY_WITH_A_FALLBACK = "retryOrElse";
const SCHEDULE_OPTION = "schedule";
const COUNT_ONLY_SCHEDULE = "Schedule.recurs";
const LAST = -1;
const BEFORE_THE_FALLBACK = -2;

const PREDICATE_OPTIONS: ReadonlySet<string> = new Set(["while", "until"]);

const ARRAY_PREDICATES: ReadonlySet<string> = new Set(["every", "some", "includes"]);

const STRING_PREDICATES: ReadonlySet<string> = new Set(["includes", "startsWith", "endsWith"]);

const NUMBER_PREDICATES: ReadonlySet<string> = new Set([
  "isFinite",
  "isInteger",
  "isNaN",
  "isSafeInteger",
]);

const NON_EFFECT_VALUES: ReadonlySet<string> = new Set([
  "Literal",
  "ArrayExpression",
  "ObjectExpression",
  "TemplateLiteral",
  "UnaryExpression",
  "BinaryExpression",
  "UpdateExpression",
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ClassExpression",
  "ClassDeclaration",
]);

const isBooleanType = (annotation: ESTree.Node | undefined): boolean => {
  if (annotation?.type === "TSParenthesizedType") {
    return isBooleanType(annotation.typeAnnotation);
  }
  if (annotation?.type === "TSUnionType") {
    return annotation.types.every(isBooleanType);
  }
  const isBooleanLiteral =
    annotation?.type === "TSLiteralType" &&
    annotation.literal.type === "Literal" &&
    typeof annotation.literal.value === "boolean";
  return annotation?.type === "TSBooleanKeyword" || isBooleanLiteral;
};

const hasBooleanReturnType = (node: ESTree.Node) =>
  "returnType" in node && isBooleanType(node.returnType?.typeAnnotation);

const isBooleanCall = (callee: ESTree.Node, sourceCode: SourceCode) => {
  const value = constantValue(callee, sourceCode);
  const isBooleanConversion = isGlobalReference(value, sourceCode, "Boolean");
  const isEffectPredicate = effectModuleOperation(value, sourceCode, "Effect") === "isEffect";
  const isKnownBooleanCall =
    isBooleanConversion || isEffectPredicate || hasBooleanReturnType(value);
  if (isKnownBooleanCall) {
    return true;
  }
  if (value.type !== "MemberExpression") {
    return false;
  }
  const receiver = constantValue(value.object, sourceCode);
  const method = memberName(value) ?? "";
  if (receiver.type === "ArrayExpression") {
    return ARRAY_PREDICATES.has(method);
  }
  const isString =
    receiver.type === "TemplateLiteral" ||
    (receiver.type === "Literal" && typeof receiver.value === "string");
  if (isString) {
    return STRING_PREDICATES.has(method);
  }
  const isRegexLiteral = receiver.type === "Literal" && "regex" in receiver;
  if (isRegexLiteral) {
    return method === "test";
  }
  if (receiver.type === "NewExpression") {
    const isNativeCollection = ["Map", "Set"].some((name) =>
      isGlobalReference(receiver.callee, sourceCode, name),
    );
    return isNativeCollection && (method === "has" || method === "delete");
  }
  const isArrayPredicate = method === "isArray" && isGlobalReference(receiver, sourceCode, "Array");
  const isNumberPredicate =
    NUMBER_PREDICATES.has(method) && isGlobalReference(receiver, sourceCode, "Number");
  const isObjectPredicate = method === "is" && isGlobalReference(receiver, sourceCode, "Object");
  return isArrayPredicate || isNumberPredicate || isObjectPredicate;
};

const returnedValuesIn = (node: ESTree.Node): readonly ESTree.Node[] => {
  if (node.type === "ReturnStatement") {
    return node.argument === null ? [] : [node.argument];
  }
  if (node.type === "BlockStatement") {
    return node.body.flatMap(returnedValuesIn);
  }
  if (node.type === "IfStatement") {
    return [
      ...returnedValuesIn(node.consequent),
      ...(node.alternate === null ? [] : returnedValuesIn(node.alternate)),
    ];
  }
  if (node.type === "SwitchStatement") {
    return node.cases.flatMap((branch) => branch.consequent.flatMap(returnedValuesIn));
  }
  if (node.type === "TryStatement") {
    return [
      ...returnedValuesIn(node.block),
      ...(node.handler === null ? [] : returnedValuesIn(node.handler.body)),
      ...(node.finalizer === null ? [] : returnedValuesIn(node.finalizer)),
    ];
  }
  const isLoopOrLabel =
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "WhileStatement" ||
    node.type === "DoWhileStatement" ||
    node.type === "LabeledStatement" ||
    node.type === "WithStatement";
  return isLoopOrLabel ? returnedValuesIn(node.body) : [];
};

const returnedValuesOf = (callback: ESTree.Node): readonly ESTree.Node[] | undefined => {
  const returned = returnedExpression(callback);
  if (returned !== undefined) {
    return [returned];
  }
  const isFunction =
    callback.type === "ArrowFunctionExpression" ||
    callback.type === "FunctionExpression" ||
    callback.type === "FunctionDeclaration";
  const body = isFunction ? callback.body : null;
  return body?.type === "BlockStatement" ? returnedValuesIn(body) : undefined;
};

const mayReturnAnEffect = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  seen: ReadonlySet<ESTree.Node> = new Set(),
): boolean => {
  const value = constantValue(node, sourceCode);
  if (seen.has(value)) {
    return true;
  }
  const visited = new Set([...seen, value]);
  if (value.type === "CallExpression") {
    if (isBooleanCall(value.callee, sourceCode)) {
      return false;
    }
    const returned = returnedValuesOf(constantValue(value.callee, sourceCode));
    return (
      returned === undefined ||
      returned.some((result) => mayReturnAnEffect(result, sourceCode, visited))
    );
  }
  if (value.type === "ChainExpression") {
    return mayReturnAnEffect(value.expression, sourceCode, visited);
  }
  if (value.type === "SequenceExpression") {
    const last = value.expressions.at(LAST);
    return last !== undefined && mayReturnAnEffect(last, sourceCode, visited);
  }
  if (value.type === "AssignmentExpression") {
    const isLogicalAssignment =
      value.operator === "&&=" || value.operator === "||=" || value.operator === "??=";
    const mayAssignAnEffect =
      (value.operator === "=" || isLogicalAssignment) &&
      mayReturnAnEffect(value.right, sourceCode, visited);
    return (
      mayAssignAnEffect ||
      (isLogicalAssignment && mayReturnAnEffect(value.left, sourceCode, visited))
    );
  }
  if (value.type === "ConditionalExpression") {
    return (
      mayReturnAnEffect(value.consequent, sourceCode, visited) ||
      mayReturnAnEffect(value.alternate, sourceCode, visited)
    );
  }
  if (value.type === "LogicalExpression") {
    return (
      mayReturnAnEffect(value.left, sourceCode, visited) ||
      mayReturnAnEffect(value.right, sourceCode, visited)
    );
  }
  if (value.type === "Identifier") {
    const binding = resolvedVariable(value, sourceCode)?.defs[0]?.name;
    const isBooleanBinding =
      binding?.type === "Identifier" && isBooleanType(binding.typeAnnotation?.typeAnnotation);
    return !isBooleanBinding && !isGlobalReference(value, sourceCode, "undefined");
  }
  return !NON_EFFECT_VALUES.has(value.type);
};

const predicateMayWait = (predicate: ESTree.Node, sourceCode: SourceCode) => {
  const callback = constantValue(predicate, sourceCode);
  if (hasBooleanReturnType(callback)) {
    return false;
  }
  return (
    returnedValuesOf(callback)?.some((returned) => mayReturnAnEffect(returned, sourceCode)) ?? false
  );
};

export const noInstantRetries = defineRule({
  meta: {
    type: "problem",
    messages: {
      instant: "{{usage}} retries at once, with no wait between attempts",
    },
  },
  create(context) {
    const retryOf = (callee: ESTree.Node) =>
      RETRYING_MODULES.flatMap((moduleName) => {
        const operation = effectModuleOperation(callee, context.sourceCode, moduleName);
        const isRetry = operation === RETRY || operation === RETRY_WITH_A_FALLBACK;
        return isRetry ? [{ usage: `${moduleName}.${operation}`, operation }] : [];
      }).at(0);

    const isCountOnlySchedule = (node: ESTree.Node) =>
      node.type === "CallExpression" &&
      node.arguments.length === 1 &&
      effectModuleReference(node.callee, context.sourceCode, "Schedule") === COUNT_ONLY_SCHEDULE;

    const waitsNever = (schedule: ESTree.Node) => {
      const value = unwrappedExpression(schedule);
      return (
        isGlobalReference(value, context.sourceCode, "undefined") || isCountOnlySchedule(value)
      );
    };

    const hasNoSchedule = (options: ESTree.ObjectExpression) => {
      const names = options.properties.map((property) => propertyKeyName(property));
      const isEveryOptionNamed = names.every((name) => name !== undefined);
      if (!isEveryOptionNamed) {
        return false;
      }
      const hasWaitingPredicate = options.properties.some(
        (property, index) =>
          property.type === "Property" &&
          PREDICATE_OPTIONS.has(names[index] ?? "") &&
          predicateMayWait(property.value, context.sourceCode),
      );
      if (hasWaitingPredicate) {
        return false;
      }
      const schedule = options.properties.find(
        (property, index) => names[index] === SCHEDULE_OPTION && property.type === "Property",
      );
      return schedule?.type !== "Property" || waitsNever(schedule.value);
    };

    const isInstantPolicy = (policy: ESTree.Node) => {
      const value = unwrappedExpression(policy);
      return value.type === "ObjectExpression" ? hasNoSchedule(value) : isCountOnlySchedule(value);
    };

    return {
      CallExpression(node: ESTree.CallExpression) {
        const retry = retryOf(node.callee);
        if (retry === undefined) {
          return;
        }
        const policy = node.arguments.at(retry.operation === RETRY ? LAST : BEFORE_THE_FALLBACK);
        const retriesAtOnce = policy !== undefined && isInstantPolicy(policy);
        if (retriesAtOnce) {
          context.report({ node: policy, messageId: "instant", data: { usage: retry.usage } });
        }
      },
    };
  },
});
