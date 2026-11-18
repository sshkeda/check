import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constantValue,
  isAssignmentTarget,
  isGlobalReference,
  memberName,
  propertyKeyName,
  resolvedVariable,
  staticKeyName,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const OBJECT = "Object";

const ERROR = "Error";

const REFLECT = "Reflect";

const PROTOTYPE = "prototype";

const PARENT_PROTOTYPE = "__proto__";

const OBJECT_ASSIGN = "Object.assign";

const REFLECT_SET = "Reflect.set";

const CONSTRUCTORS_UNDER_OBJECT = [
  "Array",
  "ArrayBuffer",
  "BigInt",
  "Boolean",
  "AsyncDisposableStack",
  "DataView",
  "Date",
  "DisposableStack",
  "Error",
  "FinalizationRegistry",
  "Function",
  "Iterator",
  "Map",
  "Number",
  "Promise",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "WeakMap",
  "WeakRef",
  "WeakSet",
] as const;

const ERROR_SUBCLASSES = [
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SuppressedError",
  "SyntaxError",
  "TypeError",
  "URIError",
] as const;

const TYPED_ARRAYS = [
  "BigInt64Array",
  "BigUint64Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
] as const;

const PARENT_PROTOTYPES = new Map<string, string | undefined>([
  [OBJECT, undefined],
  ...CONSTRUCTORS_UNDER_OBJECT.map((name) => [name, OBJECT] as const),
  ...ERROR_SUBCLASSES.map((name) => [name, ERROR] as const),
  ...TYPED_ARRAYS.map((name) => [name, undefined] as const),
]);

const GLOBAL_CONTAINERS: ReadonlySet<string> = new Set(["global", "globalThis", "self", "window"]);

const OBJECT_WRITES: ReadonlySet<string> = new Set([
  "assign",
  "defineProperties",
  "defineProperty",
  "setPrototypeOf",
]);

const REFLECT_WRITES: ReadonlySet<string> = new Set([
  "defineProperty",
  "deleteProperty",
  "set",
  "setPrototypeOf",
]);

const intrinsic = (
  kind: "constructor" | "container" | "prototype" | "reflect" | "write",
  name: string,
) => ({ kind, name });

const globalIntrinsic = (name: string) => {
  if (PARENT_PROTOTYPES.has(name)) {
    return intrinsic("constructor", name);
  }
  if (name === REFLECT) {
    return intrinsic("reflect", name);
  }
  return GLOBAL_CONTAINERS.has(name) ? intrinsic("container", name) : undefined;
};

const memberOfIntrinsic = (owner: ReturnType<typeof intrinsic> | undefined, key: string) => {
  if (owner === undefined) {
    return;
  }
  if (owner.kind === "container") {
    return globalIntrinsic(key);
  }
  const isPrototypeOfConstructor = owner.kind === "constructor" && key === PROTOTYPE;
  if (isPrototypeOfConstructor) {
    return intrinsic("prototype", owner.name);
  }
  const isObjectWrite =
    owner.kind === "constructor" && owner.name === OBJECT && OBJECT_WRITES.has(key);
  const isReflectWrite = owner.kind === "reflect" && REFLECT_WRITES.has(key);
  const isWrite = isObjectWrite || isReflectWrite;
  if (isWrite) {
    return intrinsic("write", `${owner.name}.${key}`);
  }
  const isParentOfPrototype = owner.kind === "prototype" && key === PARENT_PROTOTYPE;
  const parent = isParentOfPrototype ? PARENT_PROTOTYPES.get(owner.name) : undefined;
  return parent === undefined ? undefined : intrinsic("prototype", parent);
};

const staticMemberKey = (node: ESTree.MemberExpression, sourceCode: SourceCode) => {
  const name = memberName(node);
  const isUnresolvedComputedKey = name === undefined && node.computed;
  return isUnresolvedComputedKey ? staticKeyName(constantValue(node.property, sourceCode)) : name;
};

const constantAlias = (node: ESTree.Node, sourceCode: SourceCode) => {
  const variable = resolvedVariable(node, sourceCode);
  const definitions = variable?.defs ?? [];
  const [definition] = definitions;
  const declarator = definitions.length === 1 ? definition?.node : undefined;
  const isConstantDeclarator =
    declarator?.type === "VariableDeclarator" &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const";
  const value = isConstantDeclarator ? declarator.init : null;
  const isConstantWithAValue =
    variable !== undefined && definition !== undefined && isConstantDeclarator && value !== null;
  if (!isConstantWithAValue) {
    return;
  }
  if (declarator.id.type === "Identifier") {
    return { variable, value, key: undefined };
  }
  const property = definition.name.parent;
  const isDestructuredByKey =
    property.type === "Property" &&
    property.value === definition.name &&
    property.parent === declarator.id;
  const key = isDestructuredByKey ? propertyKeyName(property) : undefined;
  return key === undefined ? undefined : { variable, value, key };
};

const intrinsicOf = (
  expression: ESTree.Node,
  sourceCode: SourceCode,
  seen: ReadonlySet<Variable> = new Set(),
): ReturnType<typeof intrinsic> | undefined => {
  const node = unwrappedExpression(expression);
  if (node.type === "ChainExpression") {
    return intrinsicOf(node.expression, sourceCode, seen);
  }
  if (node.type === "MemberExpression") {
    const key = staticMemberKey(node, sourceCode);
    return key === undefined
      ? undefined
      : memberOfIntrinsic(intrinsicOf(node.object, sourceCode, seen), key);
  }
  if (node.type !== "Identifier") {
    return;
  }
  if (isGlobalReference(node, sourceCode, node.name)) {
    return globalIntrinsic(node.name);
  }
  const alias = constantAlias(node, sourceCode);
  const isUnknownOrSeen = alias === undefined || seen.has(alias.variable);
  if (isUnknownOrSeen) {
    return;
  }
  const value = intrinsicOf(alias.value, sourceCode, new Set([...seen, alias.variable]));
  return alias.key === undefined ? value : memberOfIntrinsic(value, alias.key);
};

const prototypeWrittenThrough = (target: ESTree.Node, sourceCode: SourceCode) => {
  const node = unwrappedExpression(target);
  if (node.type !== "MemberExpression") {
    return;
  }
  const owner = intrinsicOf(node.object, sourceCode);
  if (owner?.kind === "prototype") {
    return owner.name;
  }
  const isPrototypeOfConstructor =
    owner?.kind === "constructor" && staticMemberKey(node, sourceCode) === PROTOTYPE;
  return isPrototypeOfConstructor ? owner.name : undefined;
};

const isChangedInPlace = (node: ESTree.MemberExpression) => {
  const changed = node.parent.type === "ChainExpression" ? node.parent : node;
  const { parent } = changed;
  const isUpdated = parent.type === "UpdateExpression" && parent.argument === changed;
  const isDeleted =
    parent.type === "UnaryExpression" &&
    parent.operator === "delete" &&
    parent.argument === changed;
  return isUpdated || isDeleted;
};

const targetOfWrite = (write: string, callArguments: readonly ESTree.Node[]) => {
  const firstSpread = callArguments.findIndex((argument) => argument.type === "SpreadElement");
  const hasSpread = firstSpread !== -1;
  const argumentsBeforeSpread = hasSpread ? callArguments.slice(0, firstSpread) : callArguments;
  const [target, , , receiver] = argumentsBeforeSpread;
  if (write === REFLECT_SET) {
    return hasSpread ? receiver : (receiver ?? target);
  }
  const isAssignWithoutSources = write === OBJECT_ASSIGN && callArguments.length === 1;
  return isAssignWithoutSources ? undefined : target;
};

const prototypeWrittenByCall = (node: ESTree.CallExpression, sourceCode: SourceCode) => {
  const callee = intrinsicOf(node.callee, sourceCode);
  const target = callee?.kind === "write" ? targetOfWrite(callee.name, node.arguments) : undefined;
  const written = target === undefined ? undefined : intrinsicOf(target, sourceCode);
  return written?.kind === "prototype" ? written.name : undefined;
};

export const noNativePrototypeWrites = defineRule({
  meta: {
    type: "problem",
    messages: {
      nativePrototype: "the {{name}} prototype is changed",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const isWritten = isAssignmentTarget(node) || isChangedInPlace(node);
        const name = isWritten ? prototypeWrittenThrough(node, context.sourceCode) : undefined;
        if (name !== undefined) {
          context.report({ node, messageId: "nativePrototype", data: { name } });
        }
      },
      CallExpression(node) {
        const name = prototypeWrittenByCall(node, context.sourceCode);
        if (name !== undefined) {
          context.report({ node, messageId: "nativePrototype", data: { name } });
        }
      },
    };
  },
});
