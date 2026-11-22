import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  GLOBAL_CONTAINERS,
  globalValueOf,
  staticMemberKey,
} from "./resolve-globals-through-constant-aliases.ts";
import {
  constantValue,
  propertyKeyName,
  staticKeyName,
} from "./resolve-what-an-expression-imports.ts";

const PROMISE = "Promise";

const COMBINATORS: ReadonlySet<string> = new Set(["all", "allSettled", "race", "any"]);

const NO_OWN_STATICS: ReadonlySet<string> = new Set();

const promiseValue = (
  kind: "constructor" | "container" | "subclass",
  ownStatics: ReadonlySet<string> = NO_OWN_STATICS,
) => ({ kind, ownStatics });

const globalPromiseValue = (name: string) => {
  if (name === PROMISE) {
    return promiseValue("constructor");
  }
  return GLOBAL_CONTAINERS.has(name) ? promiseValue("container") : undefined;
};

const memberOfPromiseValue = (owner: ReturnType<typeof promiseValue> | undefined, key: string) =>
  owner?.kind === "container" ? globalPromiseValue(key) : undefined;

const classMemberKeyName = (
  member: ESTree.AccessorProperty | ESTree.MethodDefinition | ESTree.PropertyDefinition,
  sourceCode: SourceCode,
) => {
  const { computed, key } = member;
  if (computed) {
    return staticKeyName(constantValue(key, sourceCode));
  }
  return key.type === "Identifier" ? key.name : staticKeyName(key);
};

const ownStaticName = (element: ESTree.ClassElement, sourceCode: SourceCode) => {
  const isClassMember =
    element.type === "MethodDefinition" ||
    element.type === "PropertyDefinition" ||
    element.type === "AccessorProperty";
  if (!isClassMember) {
    return;
  }
  const isDeclaredOnly = element.type === "PropertyDefinition" && element.declare === true;
  const isRuntimeStatic = element.static && !isDeclaredOnly;
  return isRuntimeStatic ? classMemberKeyName(element, sourceCode) : undefined;
};

const ownStaticNames = (declaration: ESTree.Class, sourceCode: SourceCode) =>
  declaration.body.body.flatMap((element) => {
    const name = ownStaticName(element, sourceCode);
    return name === undefined ? [] : [name];
  });

const subclassOfPromiseValue = (
  superClass: ReturnType<typeof promiseValue> | undefined,
  declaration: ESTree.Class,
  sourceCode: SourceCode,
) => {
  const extendsPromise = superClass !== undefined && superClass.kind !== "container";
  return extendsPromise
    ? promiseValue(
        "subclass",
        new Set([...superClass.ownStatics, ...ownStaticNames(declaration, sourceCode)]),
      )
    : undefined;
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
  const isSubclassWithoutOwnMember = value?.kind === "subclass" && !value.ownStatics.has(member);
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
    const reportDestructuredCombinators = (pattern: ESTree.Node, source: ESTree.Node | null) => {
      const isObjectPatternWithSource = pattern.type === "ObjectPattern" && source !== null;
      if (!isObjectPatternWithSource) {
        return;
      }
      const value = promiseValueOf(source, sourceCode);
      for (const property of pattern.properties) {
        const member = propertyKeyName(property);
        const isNativeCombinator = member !== undefined && reachesNativeCombinator(value, member);
        if (isNativeCombinator) {
          context.report({ node: property, messageId: "combinator", data: { member } });
        }
      }
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
