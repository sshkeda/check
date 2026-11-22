import type { Definition, ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

import {
  constantValue,
  memberName,
  propertyKeyName,
  staticKeyName,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

export const GLOBAL_CONTAINERS: ReadonlySet<string> = new Set([
  "global",
  "globalThis",
  "self",
  "window",
]);

export const staticMemberKey = (node: ESTree.MemberExpression, sourceCode: SourceCode) => {
  const name = memberName(node);
  const isUnresolvedComputedKey = name === undefined && node.computed;
  return isUnresolvedComputedKey ? staticKeyName(constantValue(node.property, sourceCode)) : name;
};

const TYPE_DECLARATIONS: ReadonlySet<string> = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSTypeParameter",
]);

const isTypeOnlyDefinition = (definition: Definition) => {
  const { node, parent } = definition;
  const isTypeOnlySpecifier = node.type === "ImportSpecifier" && node.importKind === "type";
  const isTypeOnlyImport = parent?.type === "ImportDeclaration" && parent.importKind === "type";
  return TYPE_DECLARATIONS.has(node.type) || isTypeOnlySpecifier || isTypeOnlyImport;
};

const bindingVisibleFrom = (
  scope: Scope,
  name: string,
  ignoresTypeOnlyBindings: boolean,
): { readonly variable: Variable; readonly definitions: readonly Definition[] } | undefined => {
  const variable = scope.set.get(name);
  const allDefinitions = variable?.defs ?? [];
  const definitions = ignoresTypeOnlyBindings
    ? allDefinitions.filter((definition) => !isTypeOnlyDefinition(definition))
    : allDefinitions;
  const isTypeOnlyBinding = allDefinitions.length > 0 && definitions.length === 0;
  const isVisibleBinding = variable !== undefined && !isTypeOnlyBinding;
  if (isVisibleBinding) {
    return { variable, definitions };
  }
  return scope.upper === null
    ? undefined
    : bindingVisibleFrom(scope.upper, name, ignoresTypeOnlyBindings);
};

const bindingOf = (node: ESTree.Node, sourceCode: SourceCode, ignoresTypeOnlyBindings: boolean) =>
  node.type === "Identifier"
    ? bindingVisibleFrom(sourceCode.getScope(node), node.name, ignoresTypeOnlyBindings)
    : undefined;

const isGlobalBinding = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  ignoresTypeOnlyBindings: boolean,
) => {
  const binding = bindingOf(node, sourceCode, ignoresTypeOnlyBindings);
  return binding === undefined || binding.definitions.length === 0;
};

const onlyDefinitionOf = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  ignoresTypeOnlyBindings: boolean,
) => {
  const binding = bindingOf(node, sourceCode, ignoresTypeOnlyBindings);
  const variable = binding?.variable;
  const definitions = binding?.definitions ?? [];
  const [definition] = definitions;
  const isOnlyDefinition =
    variable !== undefined && definition !== undefined && definitions.length === 1;
  return isOnlyDefinition ? { variable, definition } : undefined;
};

const constantAlias = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  ignoresTypeOnlyBindings: boolean,
) => {
  const defined = onlyDefinitionOf(node, sourceCode, ignoresTypeOnlyBindings);
  const declarator = defined?.definition.node;
  const isConstantDeclarator =
    declarator?.type === "VariableDeclarator" &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const";
  const value = isConstantDeclarator ? declarator.init : null;
  const isConstantWithAValue = defined !== undefined && isConstantDeclarator && value !== null;
  if (!isConstantWithAValue) {
    return;
  }
  const { variable, definition } = defined;
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

const declaredClass = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  ignoresTypeOnlyBindings: boolean,
) => {
  const defined = onlyDefinitionOf(node, sourceCode, ignoresTypeOnlyBindings);
  const declared = defined?.definition.node;
  const isDeclaredClass =
    (declared?.type === "ClassDeclaration" || declared?.type === "ClassExpression") &&
    defined !== undefined;
  return isDeclaredClass ? { variable: defined.variable, declared } : undefined;
};

export const globalValueOf = <Value>(
  expression: ESTree.Node,
  sourceCode: SourceCode,
  resolver: {
    readonly global: (name: string) => Value | undefined;
    readonly member: (owner: Value | undefined, key: string) => Value | undefined;
    readonly subclass?: (
      superClass: Value | undefined,
      declaration: ESTree.Class,
    ) => Value | undefined;
    readonly ignoresTypeOnlyBindings?: boolean;
  },
  seen: ReadonlySet<Variable> = new Set(),
): Value | undefined => {
  const node = unwrappedExpression(expression);
  if (node.type === "ChainExpression") {
    return globalValueOf(node.expression, sourceCode, resolver, seen);
  }
  if (node.type === "MemberExpression") {
    const key = staticMemberKey(node, sourceCode);
    return key === undefined
      ? undefined
      : resolver.member(globalValueOf(node.object, sourceCode, resolver, seen), key);
  }
  const isClass = node.type === "ClassDeclaration" || node.type === "ClassExpression";
  if (isClass) {
    const { subclass } = resolver;
    const { superClass } = node;
    const isSubclassOfAValue = subclass !== undefined && superClass !== null;
    return isSubclassOfAValue
      ? subclass(globalValueOf(superClass, sourceCode, resolver, seen), node)
      : undefined;
  }
  if (node.type !== "Identifier") {
    return;
  }
  const ignoresTypeOnlyBindings = resolver.ignoresTypeOnlyBindings === true;
  if (isGlobalBinding(node, sourceCode, ignoresTypeOnlyBindings)) {
    return resolver.global(node.name);
  }
  const alias = constantAlias(node, sourceCode, ignoresTypeOnlyBindings);
  const isUnseenAlias = alias !== undefined && !seen.has(alias.variable);
  if (isUnseenAlias) {
    const value = globalValueOf(
      alias.value,
      sourceCode,
      resolver,
      new Set([...seen, alias.variable]),
    );
    return alias.key === undefined ? value : resolver.member(value, alias.key);
  }
  const declared =
    resolver.subclass === undefined
      ? undefined
      : declaredClass(node, sourceCode, ignoresTypeOnlyBindings);
  const isUnseenClass = declared !== undefined && !seen.has(declared.variable);
  return isUnseenClass
    ? globalValueOf(declared.declared, sourceCode, resolver, new Set([...seen, declared.variable]))
    : undefined;
};
