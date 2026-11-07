import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  effectModuleOperation,
  effectModuleReference,
  effectOperation,
  importedExpression,
  isGlobalReference,
  isMemberExpressionObject,
  isReferencePosition,
  isShorthandKey,
  memberName,
  propertyKeyName,
  resolvedVariable,
  staticKeyName,
} from "./resolve-what-an-expression-imports.ts";

export const NUMBER_PARSERS = new Set(["parseInt", "parseFloat"]);
const RADIX_PARSER = "parseInt";
const SCHEMA_DECODED_RADIX = 10;
const SMALLEST_RADIX = 2;
const LARGEST_RADIX = 36;
const UNCHECKED_SCHEMAS = new Set(["Schema.Any"]);
const JSON_BODY_READ = "json";
const PROMISE_OPERATIONS = new Set(["promise", "tryPromise"]);
const PROMISE_THUNK_KEY = "try";
const PIPE = "pipe";
const FLAT_MAP_OPERATION = "flatMap";
const SCHEMA_DECODERS = new Set([
  "decodeEffect",
  "decodeExit",
  "decodeOption",
  "decodePromise",
  "decodeResult",
  "decodeSync",
  "decodeUnknownEffect",
  "decodeUnknownExit",
  "decodeUnknownOption",
  "decodeUnknownPromise",
  "decodeUnknownResult",
  "decodeUnknownSync",
]);

const localDefinition = (node: ESTree.Node, sourceCode: SourceCode) => {
  const variable = resolvedVariable(node, sourceCode);
  if (variable?.references.some((reference) => reference.isWrite() && !reference.init) === true) {
    return node;
  }
  const definition = variable?.defs[0]?.node;
  return definition?.type === "VariableDeclarator"
    ? (definition.init ?? node)
    : (definition ?? node);
};

const hasLocalJsonMethod = (receiver: ESTree.Node, sourceCode: SourceCode) => {
  const value = localDefinition(receiver, sourceCode);
  if (value.type === "ObjectExpression") {
    const property = value.properties.findLast(
      (entry) => entry.type === "SpreadElement" || propertyKeyName(entry) === JSON_BODY_READ,
    );
    return (
      property?.type === "Property" &&
      property.kind === "init" &&
      (property.value.type === "FunctionExpression" ||
        property.value.type === "ArrowFunctionExpression")
    );
  }
  if (value.type !== "NewExpression") {
    return false;
  }
  const constructor = localDefinition(value.callee, sourceCode);
  const isLocalClass =
    constructor.type === "ClassDeclaration" || constructor.type === "ClassExpression";
  return (
    isLocalClass &&
    constructor.body.body.some((member) => {
      if (member.type !== "MethodDefinition") {
        return false;
      }
      const { computed, key } = member;
      const isNamedMethod = !computed && key.type === "Identifier";
      const name = isNamedMethod ? key.name : staticKeyName(key);
      return !member.static && member.kind === "method" && name === JSON_BODY_READ;
    })
  );
};

const numberLiteral = (node: ESTree.Node) => {
  const isTypeOnlyWrapper = node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression";
  const literal = isTypeOnlyWrapper ? node.expression : node;
  const isNumberLiteral = literal.type === "Literal" && typeof literal.value === "number";
  return isNumberLiteral ? literal.value : undefined;
};

const constantNumber = (node: ESTree.Node, sourceCode: SourceCode) => {
  const literal = numberLiteral(node);
  if (literal !== undefined) {
    return literal;
  }
  const definition = resolvedVariable(node, sourceCode)?.defs[0]?.node;
  const isConstant =
    definition?.type === "VariableDeclarator" &&
    definition.parent.type === "VariableDeclaration" &&
    definition.parent.kind === "const";
  const value = isConstant ? definition.init : null;
  return value === null ? undefined : numberLiteral(value);
};

const parsesARadixNoSchemaDecodes = (parser: ESTree.Node, name: string, sourceCode: SourceCode) => {
  const call = parser.parent;
  const isCalledParseInt =
    name === RADIX_PARSER && call?.type === "CallExpression" && call.callee === parser;
  if (!isCalledParseInt) {
    return false;
  }
  const radixArgument = call.arguments[1];
  const radix = radixArgument === undefined ? undefined : constantNumber(radixArgument, sourceCode);
  const isRadixOtherThanDecimal =
    radix !== undefined &&
    Number.isInteger(radix) &&
    radix >= SMALLEST_RADIX &&
    radix <= LARGEST_RADIX &&
    radix !== SCHEMA_DECODED_RADIX;
  return isRadixOtherThanDecimal;
};

const isSchemaDecoder = (node: ESTree.Node, sourceCode: SourceCode) =>
  node.type === "CallExpression" &&
  SCHEMA_DECODERS.has(effectModuleOperation(node.callee, sourceCode, "Schema") ?? "");

const promiseCallRunning = (thunk: ESTree.ArrowFunctionExpression, sourceCode: SourceCode) => {
  const holder = thunk.parent;
  const isTryProperty =
    holder.type === "Property" &&
    holder.value === thunk &&
    propertyKeyName(holder) === PROMISE_THUNK_KEY;
  const argument = isTryProperty ? holder.parent : thunk;
  const call = argument.parent;
  const isPromiseCall =
    call?.type === "CallExpression" &&
    call.arguments[0] === argument &&
    PROMISE_OPERATIONS.has(effectOperation(call.callee, sourceCode) ?? "");
  return isPromiseCall ? call : undefined;
};

const awaitedValue = (promise: ESTree.Node) =>
  promise.parent?.type === "AwaitExpression" ? promise.parent : promise;

const yieldedValue = (effect: ESTree.Node) => {
  const yielding = effect.parent;
  const isYielded = yielding?.type === "YieldExpression" && yielding.delegate;
  return isYielded ? yielding : undefined;
};

const isFlatMapInto = (step: ESTree.Node | undefined, sourceCode: SourceCode) =>
  step?.type === "CallExpression" &&
  effectOperation(step.callee, sourceCode) === FLAT_MAP_OPERATION &&
  step.arguments.length === 1 &&
  step.arguments[0] !== undefined &&
  isSchemaDecoder(step.arguments[0], sourceCode);

const isPipeFunction = (callee: ESTree.Node, sourceCode: SourceCode) => {
  const imported = importedExpression(callee, sourceCode);
  const isPipeOfEffect = imported?.module === "effect" && imported.members.join(".") === PIPE;
  return isPipeOfEffect || effectModuleOperation(callee, sourceCode, "Function") === PIPE;
};

const isPipedIntoDecoder = (effect: ESTree.Node, sourceCode: SourceCode) => {
  const parent = effect.parent;
  const isPipeMethod =
    parent?.type === "MemberExpression" && parent.object === effect && memberName(parent) === PIPE;
  if (isPipeMethod) {
    const pipeCall = parent.parent;
    return (
      pipeCall.type === "CallExpression" &&
      pipeCall.callee === parent &&
      isFlatMapInto(pipeCall.arguments[0], sourceCode)
    );
  }
  if (parent?.type !== "CallExpression") {
    return false;
  }
  const [first, second, ...rest] = parent.arguments;
  const isFirstOfTwoArguments = first === effect && second !== undefined && rest.length === 0;
  if (!isFirstOfTwoArguments) {
    return false;
  }
  const isDataFirstFlatMap =
    effectOperation(parent.callee, sourceCode) === FLAT_MAP_OPERATION &&
    isSchemaDecoder(second, sourceCode);
  const isPipeFunctionCall =
    isPipeFunction(parent.callee, sourceCode) && isFlatMapInto(second, sourceCode);
  return isDataFirstFlatMap || isPipeFunctionCall;
};

const isDecodedOrBoundAsUnknown = (value: ESTree.Node, sourceCode: SourceCode) => {
  const parent = value.parent;
  const isDecoded =
    parent?.type === "CallExpression" &&
    parent.arguments[0] === value &&
    isSchemaDecoder(parent.callee, sourceCode);
  const isBoundAsUnknown =
    parent?.type === "VariableDeclarator" &&
    parent.init === value &&
    parent.id.type === "Identifier" &&
    parent.id.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword";
  return isDecoded || isBoundAsUnknown;
};

const isDecodedOrBoundAsUnknownRightAway = (
  body: ESTree.CallExpression,
  sourceCode: SourceCode,
) => {
  const parent = body.parent;
  const isThenMethod =
    parent.type === "MemberExpression" && parent.object === body && memberName(parent) === "then";
  if (isThenMethod) {
    const call = parent.parent;
    const isThenCall = call.type === "CallExpression" && call.callee === parent;
    const decoder = isThenCall ? call.arguments[0] : undefined;
    return decoder !== undefined && isSchemaDecoder(decoder, sourceCode);
  }
  const value = awaitedValue(body);
  const thunk = value.parent;
  const isThunkBody = thunk?.type === "ArrowFunctionExpression" && thunk.body === value;
  const effect = isThunkBody ? promiseCallRunning(thunk, sourceCode) : undefined;
  if (effect === undefined) {
    return value !== body && isDecodedOrBoundAsUnknown(value, sourceCode);
  }
  const yielded = yieldedValue(effect);
  return yielded === undefined
    ? isPipedIntoDecoder(effect, sourceCode)
    : isDecodedOrBoundAsUnknown(yielded, sourceCode);
};

export const noUncheckedParsing = defineRule({
  meta: {
    type: "problem",
    messages: {
      jsonBody: "json() parses JSON without a Schema",
      numberParse: "{{usage}} parses a number without a Schema",
      uncheckedSchema: "{{usage}} accepts any value without a check",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const reportUncheckedSchema = (node: ESTree.Node) => {
      const usage = effectModuleReference(node, sourceCode, "Schema");
      const schema = [...UNCHECKED_SCHEMAS].find(
        (unchecked) => usage === unchecked || usage?.startsWith(`${unchecked}.`) === true,
      );
      if (schema !== undefined) {
        context.report({ node, messageId: "uncheckedSchema", data: { usage: schema } });
      }
    };
    return {
      CallExpression(node) {
        const readsTheBodyAsJson =
          node.callee.type === "MemberExpression" &&
          memberName(node.callee) === JSON_BODY_READ &&
          node.arguments.length === 0 &&
          !hasLocalJsonMethod(node.callee.object, sourceCode) &&
          !isDecodedOrBoundAsUnknownRightAway(node, sourceCode);
        if (readsTheBodyAsJson) {
          context.report({ node, messageId: "jsonBody" });
        }
      },
      Identifier(node) {
        reportUncheckedSchema(node);
        const isGlobalNumberParser =
          NUMBER_PARSERS.has(node.name) &&
          !isShorthandKey(node) &&
          (isMemberExpressionObject(node) || isReferencePosition(node)) &&
          isGlobalReference(node, sourceCode, node.name) &&
          !parsesARadixNoSchemaDecodes(node, node.name, sourceCode);
        if (isGlobalNumberParser) {
          context.report({ node, messageId: "numberParse", data: { usage: node.name } });
        }
      },
      MemberExpression(node) {
        reportUncheckedSchema(node);
        const parser = memberName(node);
        const isNumberParser =
          parser !== undefined &&
          NUMBER_PARSERS.has(parser) &&
          isGlobalReference(node.object, sourceCode, "Number") &&
          !parsesARadixNoSchemaDecodes(node, parser, sourceCode);
        if (isNumberParser) {
          context.report({ node, messageId: "numberParse", data: { usage: `Number.${parser}` } });
        }
      },
    };
  },
});
