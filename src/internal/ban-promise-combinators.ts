import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  GLOBAL_CONTAINERS,
  globalValueOf,
  staticMemberKey,
} from "./resolve-globals-through-constant-aliases.ts";
import {
  constantValue,
  memberName,
  propertyKeyName,
  staticKeyName,
} from "./resolve-what-an-expression-imports.ts";

const PROMISE = "Promise";

const COMBINATORS: ReadonlySet<string> = new Set(["all", "allSettled", "race", "any"]);

const NO_OWN_STATICS: ReadonlySet<string> = new Set();

const promiseValue = (
  kind: "constructor" | "container" | "subclass",
  ownStatics: ReadonlySet<string> = NO_OWN_STATICS,
  hasUnresolvedStatics = false,
) => ({ kind, ownStatics, hasUnresolvedStatics });

const globalPromiseValue = (name: string) => {
  if (name === PROMISE) {
    return promiseValue("constructor");
  }
  return GLOBAL_CONTAINERS.has(name) ? promiseValue("container") : undefined;
};

const memberOfPromiseValue = (owner: ReturnType<typeof promiseValue> | undefined, key: string) =>
  owner?.kind === "container" ? globalPromiseValue(key) : undefined;

const SYMBOL = "Symbol";

const literalKeyName = (key: ESTree.Node) =>
  key.type === "Literal" ? String(key.value) : staticKeyName(key);

const MOST_CONSTANTS_FOLDED_INTO_A_KEY = 32;

const foldedConstant = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  depth = 0,
): number | string | undefined => {
  if (depth > MOST_CONSTANTS_FOLDED_INTO_A_KEY) {
    return;
  }
  const value = constantValue(node, sourceCode);
  const fold = (part: ESTree.Node) => foldedConstant(part, sourceCode, depth + 1);
  if (value.type === "Literal") {
    return typeof value.value === "number" ? value.value : String(value.value);
  }
  if (value.type === "TemplateLiteral") {
    const parts = value.expressions.map(fold);
    const cooked = value.quasis.map((quasi) => quasi.value.cooked);
    const isFoldable = !parts.includes(undefined) && !cooked.includes(null);
    return isFoldable
      ? cooked.map((text, index) => `${text ?? ""}${String(parts[index] ?? "")}`).join("")
      : undefined;
  }
  const isSum = value.type === "BinaryExpression" && value.operator === "+";
  if (!isSum) {
    return;
  }
  const left = fold(value.left);
  const right = fold(value.right);
  const isUnfoldable = left === undefined || right === undefined;
  if (isUnfoldable) {
    return;
  }
  const areNumbers = typeof left === "number" && typeof right === "number";
  return areNumbers ? left + right : `${left}${right}`;
};

const isGlobalSymbol = (node: ESTree.Node) => {
  if (node.type === "Identifier") {
    return node.name === SYMBOL;
  }
  const isSymbolOfAContainer =
    node.type === "MemberExpression" &&
    memberName(node) === SYMBOL &&
    node.object.type === "Identifier" &&
    GLOBAL_CONTAINERS.has(node.object.name);
  return isSymbolOfAContainer;
};

const isSymbolKey = (key: ESTree.Node) => {
  const value = key.type === "CallExpression" ? key.callee : key;
  return (
    isGlobalSymbol(value) || (value.type === "MemberExpression" && isGlobalSymbol(value.object))
  );
};

const classMemberKeyNames = (
  member: ESTree.AccessorProperty | ESTree.MethodDefinition | ESTree.PropertyDefinition,
  sourceCode: SourceCode,
): readonly (string | undefined)[] => {
  const { computed, key } = member;
  if (key.type === "PrivateIdentifier") {
    return [];
  }
  if (!computed) {
    return [key.type === "Identifier" ? key.name : literalKeyName(key)];
  }
  if (isSymbolKey(constantValue(key, sourceCode))) {
    return [];
  }
  const name = foldedConstant(key, sourceCode);
  return [name === undefined ? undefined : String(name)];
};

const ownStaticKeyNames = (element: ESTree.ClassElement, sourceCode: SourceCode) => {
  const isClassMember =
    element.type === "MethodDefinition" ||
    element.type === "PropertyDefinition" ||
    element.type === "AccessorProperty";
  if (!isClassMember) {
    return [];
  }
  const isDeclaredOnly = element.type === "PropertyDefinition" && element.declare === true;
  const isRuntimeStatic = element.static && !isDeclaredOnly;
  return isRuntimeStatic ? classMemberKeyNames(element, sourceCode) : [];
};

const ownStatics = (declaration: ESTree.Class, sourceCode: SourceCode) => {
  const keyNames = declaration.body.body.flatMap((element) =>
    ownStaticKeyNames(element, sourceCode),
  );
  return {
    names: keyNames.flatMap((name) => (name === undefined ? [] : [name])),
    hasUnresolved: keyNames.includes(undefined),
  };
};

const subclassOfPromiseValue = (
  superClass: ReturnType<typeof promiseValue> | undefined,
  declaration: ESTree.Class,
  sourceCode: SourceCode,
) => {
  const extendsPromise = superClass !== undefined && superClass.kind !== "container";
  if (!extendsPromise) {
    return;
  }
  const { names, hasUnresolved } = ownStatics(declaration, sourceCode);
  return promiseValue(
    "subclass",
    new Set([...superClass.ownStatics, ...names]),
    superClass.hasUnresolvedStatics || hasUnresolved,
  );
};

const promiseValueOf = (expression: ESTree.Node, sourceCode: SourceCode) =>
  globalValueOf(expression, sourceCode, {
    global: globalPromiseValue,
    member: memberOfPromiseValue,
    subclass: (superClass, declaration) =>
      subclassOfPromiseValue(superClass, declaration, sourceCode),
    ignoresTypeOnlyBindings: true,
  });

const reachesNativeCombinator = (
  value: ReturnType<typeof promiseValue> | undefined,
  member: string,
) => {
  const isConstructor = value?.kind === "constructor";
  const isSubclassWithoutOwnMember =
    value?.kind === "subclass" && !value.hasUnresolvedStatics && !value.ownStatics.has(member);
  return COMBINATORS.has(member) && (isConstructor || isSubclassWithoutOwnMember);
};

const isPromiseConstructor = (expression: ESTree.Node, sourceCode: SourceCode) =>
  promiseValueOf(expression, sourceCode)?.kind === "constructor";

const classBodyOfStaticSuper = (node: ESTree.Node): ESTree.Node | undefined => {
  const { parent } = node;
  if (parent === null) {
    return;
  }
  const isClassMemberValue =
    (parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition" ||
      parent.type === "AccessorProperty") &&
    parent.value === node;
  if (isClassMemberValue) {
    return parent.static ? parent.parent : undefined;
  }
  const isOwnFunction = node.type === "FunctionExpression" || node.type === "FunctionDeclaration";
  if (isOwnFunction) {
    return;
  }
  return parent.type === "StaticBlock" ? parent.parent : classBodyOfStaticSuper(parent);
};

const staticSuperValueOf = (node: ESTree.Super, sourceCode: SourceCode) => {
  const home = classBodyOfStaticSuper(node)?.parent;
  const isClass = home?.type === "ClassDeclaration" || home?.type === "ClassExpression";
  const superClass = isClass ? home.superClass : null;
  return superClass === null ? undefined : promiseValueOf(superClass, sourceCode);
};

const exportedBindings = (declarator: ESTree.VariableDeclarator): readonly ESTree.Node[] => {
  const { id, init: initializer } = declarator;
  if (id.type === "Identifier") {
    return initializer === null ? [] : [initializer];
  }
  if (id.type !== "ObjectPattern") {
    return [];
  }
  return id.properties.flatMap((property) => {
    const isBoundByName = property.type === "Property" && property.value.type === "Identifier";
    return isBoundByName ? [property.value] : [];
  });
};

const exportedValues = (node: ESTree.ExportNamedDeclaration) => {
  const isTypeOrReexport = node.source !== null || node.exportKind === "type";
  if (isTypeOrReexport) {
    return [];
  }
  const { declaration } = node;
  if (declaration?.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((declarator) => exportedBindings(declarator));
  }
  return node.specifiers.flatMap((specifier) =>
    specifier.exportKind === "type" ? [] : [specifier.local],
  );
};

const nestedPattern = (property: ESTree.Node) => {
  if (property.type !== "Property") {
    return;
  }
  const { value } = property;
  return value.type === "AssignmentPattern" ? value.left : value;
};

export const noPromiseCombinators = defineRule({
  meta: {
    type: "problem",
    messages: {
      combinator: "Promise.{{member}} is used",
      exported: "the Promise constructor is exported",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const destructuredKeyName = (property: ESTree.Node) => {
      const name = propertyKeyName(property);
      const isComputedKey = name === undefined && property.type === "Property" && property.computed;
      return isComputedKey ? staticKeyName(constantValue(property.key, sourceCode)) : name;
    };
    const reportedProperties = new Set<ESTree.Node>();
    const reportCombinatorsIn = (
      pattern: ESTree.Node | undefined,
      value: ReturnType<typeof promiseValueOf>,
    ) => {
      const isObjectPatternWithValue = pattern?.type === "ObjectPattern" && value !== undefined;
      if (!isObjectPatternWithValue) {
        return;
      }
      for (const property of pattern.properties) {
        const member = destructuredKeyName(property);
        if (member === undefined) {
          continue;
        }
        if (reachesNativeCombinator(value, member)) {
          if (!reportedProperties.has(property)) {
            reportedProperties.add(property);
            context.report({ node: property, messageId: "combinator", data: { member } });
          }
        } else {
          reportCombinatorsIn(nestedPattern(property), memberOfPromiseValue(value, member));
        }
      }
    };
    const reportDestructuredCombinators = (pattern: ESTree.Node, source: ESTree.Node | null) => {
      reportCombinatorsIn(
        pattern,
        source === null ? undefined : promiseValueOf(source, sourceCode),
      );
    };
    return {
      MemberExpression(node) {
        const member = staticMemberKey(node, sourceCode);
        const isCombinatorKey = member !== undefined && COMBINATORS.has(member);
        if (!isCombinatorKey) {
          return;
        }
        const { object } = node;
        const receiver =
          object.type === "Super"
            ? staticSuperValueOf(object, sourceCode)
            : promiseValueOf(object, sourceCode);
        if (reachesNativeCombinator(receiver, member)) {
          context.report({ node, messageId: "combinator", data: { member } });
        }
      },
      VariableDeclarator(node) {
        const { id, init: initializer } = node;
        reportDestructuredCombinators(id, initializer);
      },
      AssignmentPattern(node) {
        reportDestructuredCombinators(node.left, node.right);
      },
      AssignmentExpression(node) {
        if (node.operator === "=") {
          reportDestructuredCombinators(node.left, node.right);
        }
      },
      ExportDefaultDeclaration(node) {
        if (isPromiseConstructor(node.declaration, sourceCode)) {
          context.report({ node, messageId: "exported" });
        }
      },
      ExportNamedDeclaration(node) {
        for (const value of exportedValues(node)) {
          if (isPromiseConstructor(value, sourceCode)) {
            context.report({ node: value, messageId: "exported" });
          }
        }
      },
    };
  },
});
