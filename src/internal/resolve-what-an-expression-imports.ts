import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

export const DEFAULT_EXPORT = "default";

const variableVisibleFrom = (scope: Scope, name: string): Variable | undefined => {
  const variable = scope.set.get(name);
  if (variable) {
    return variable;
  }
  if (!scope.upper) {
    return undefined;
  }
  return variableVisibleFrom(scope.upper, name);
};

export const moduleExportName = (name: ESTree.ModuleExportName) =>
  name.type === "Identifier" ? name.name : name.value;

export const enclosingFunction = (
  node: ESTree.Node,
): ESTree.ArrowFunctionExpression | ESTree.Function | undefined => {
  const parent = node.parent;
  if (!parent) {
    return undefined;
  }
  const isFunction =
    parent.type === "ArrowFunctionExpression" ||
    parent.type === "FunctionExpression" ||
    parent.type === "FunctionDeclaration";
  return isFunction ? parent : enclosingFunction(parent);
};

export const resolvedVariable = (
  node: ESTree.Node,
  sourceCode: SourceCode,
): Variable | undefined => {
  if (node.type !== "Identifier") {
    return undefined;
  }
  return variableVisibleFrom(sourceCode.getScope(node), node.name);
};

export const staticKeyName = (key: ESTree.Node) => {
  const isTemplateWithoutExpressions =
    key.type === "TemplateLiteral" && key.expressions.length === 0;
  if (isTemplateWithoutExpressions) {
    const cooked = key.quasis[0]?.value.cooked;
    return cooked === null ? undefined : cooked;
  }
  const isStringLiteral = key.type === "Literal" && typeof key.value === "string";
  return isStringLiteral ? key.value : undefined;
};

export const memberName = (node: ESTree.MemberExpression) => {
  const isUncomputedIdentifierProperty = !node.computed && node.property.type === "Identifier";
  return isUncomputedIdentifierProperty ? node.property.name : staticKeyName(node.property);
};

const withMember = (
  imported: ReturnType<typeof importedExpression>,
  member: string | undefined,
) => {
  const isMissingImportOrMember = imported === undefined || member === undefined;
  return isMissingImportOrMember
    ? undefined
    : { module: imported.module, members: [...imported.members, member] };
};

export const unwrappedExpression = (node: ESTree.Node): ESTree.Node => {
  const isTypeScriptWrapper =
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression";
  return isTypeScriptWrapper ? unwrappedExpression(node.expression) : node;
};

export const importedExpression = (
  expression: ESTree.Node,
  sourceCode: SourceCode,
):
  | {
      readonly module: string;
      readonly members: readonly string[];
    }
  | undefined => {
  const node = unwrappedExpression(expression);
  if (node.type === "MemberExpression") {
    return withMember(importedExpression(node.object, sourceCode), memberName(node));
  }
  if (node.type !== "Identifier") {
    return undefined;
  }
  const definition = resolvedVariable(node, sourceCode)?.defs[0]?.node;
  if (definition?.parent?.type !== "ImportDeclaration") {
    return undefined;
  }
  const module = definition.parent.source.value;
  if (definition.type !== "ImportSpecifier") {
    return { module, members: [] };
  }
  const importedName = moduleExportName(definition.imported);
  return { module, members: importedName === DEFAULT_EXPORT ? [] : [importedName] };
};

const isEffectModule = (
  imported: NonNullable<ReturnType<typeof importedExpression>>,
  moduleName: string,
) =>
  (imported.module === "effect" &&
    imported.members.length === 1 &&
    imported.members[0] === moduleName) ||
  (imported.module === `effect/${moduleName}` && imported.members.length === 0);

export const effectModuleOperation = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  moduleName: string,
) => {
  const imported = importedExpression(node, sourceCode);
  if (imported === undefined) {
    return;
  }
  if (imported.members.length === 0) {
    return;
  }
  const operation = imported.members.at(-1);
  return isEffectModule(
    { module: imported.module, members: imported.members.slice(0, -1) },
    moduleName,
  )
    ? operation
    : undefined;
};

const referencesEffectModule = (
  imported: NonNullable<ReturnType<typeof importedExpression>>,
  moduleName: string,
) =>
  imported.module === `effect/${moduleName}` ||
  (imported.module === "effect" && imported.members[0] === moduleName);

const CLASS_MEMBER_TYPES = new Set(["MethodDefinition", "PropertyDefinition", "AccessorProperty"]);

export const isMemberExpressionObject = (node: ESTree.Node) =>
  node.parent?.type === "MemberExpression" && node.parent.object === node;

export const isShorthandKey = (node: ESTree.Node) =>
  node.parent?.type === "Property" && node.parent.shorthand && node.parent.key === node;

const TYPESCRIPT_VALUE_WRAPPERS: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSExportAssignment",
]);

const isWrappedByTypeScript = (node: ESTree.Node, parent: ESTree.Node) =>
  TYPESCRIPT_VALUE_WRAPPERS.has(parent.type) &&
  "expression" in parent &&
  parent.expression === node;

const isExportedValue = (node: ESTree.Node, parent: ESTree.Node) =>
  (parent.type === "ExportDefaultDeclaration" && parent.declaration === node) ||
  (parent.type === "ExportSpecifier" && parent.local === node);

export const isValueOperandOfTypeScriptOrExport = (node: ESTree.Node, parent: ESTree.Node) =>
  isWrappedByTypeScript(node, parent) || isExportedValue(node, parent);

export const isReferencePosition = (node: ESTree.Node): boolean => {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (isWrappedByTypeScript(node, parent)) {
    return isReferencePosition(parent);
  }
  if (parent.type === "MemberExpression") {
    return parent.object !== node && parent.computed;
  }
  const isPropertyKey = parent.type === "Property" && parent.key === node;
  if (isPropertyKey) {
    return parent.shorthand;
  }
  const isClassMemberKey =
    CLASS_MEMBER_TYPES.has(parent.type) && "key" in parent && parent.key === node;
  if (isClassMemberKey) {
    return "computed" in parent && parent.computed;
  }
  return (
    !parent.type.startsWith("Import") &&
    !parent.type.startsWith("Export") &&
    !parent.type.startsWith("TS")
  );
};

const isOutermostReference = (node: ESTree.Node) => {
  const parent = node.parent;
  const isObjectOfMemberExpression = parent?.type === "MemberExpression" && parent.object === node;
  return !isObjectOfMemberExpression && (node.type !== "Identifier" || isReferencePosition(node));
};

const effectModuleUsage = (
  imported: NonNullable<ReturnType<typeof importedExpression>>,
  moduleName: string,
) => {
  if (!referencesEffectModule(imported, moduleName)) {
    return;
  }
  return imported.module === "effect"
    ? imported.members.join(".")
    : [moduleName, ...imported.members].join(".");
};

export const effectModuleReference = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  moduleName: string,
) => {
  if (!isOutermostReference(node)) {
    return;
  }
  const imported = importedExpression(node, sourceCode);
  return imported === undefined ? undefined : effectModuleUsage(imported, moduleName);
};

export const isGlobalReference = (node: ESTree.Node, sourceCode: SourceCode, name: string) => {
  const isIdentifierWithName = node.type === "Identifier" && node.name === name;
  if (!isIdentifierWithName) {
    return false;
  }
  const variable = resolvedVariable(node, sourceCode);
  return variable === undefined || variable.defs.length === 0;
};

const FROM_KEYWORD = "from";

export const importsEmptyBraces = (declaration: ESTree.ImportDeclaration, sourceCode: SourceCode) =>
  declaration.importKind !== "type" &&
  declaration.specifiers.length === 0 &&
  sourceCode.getTokenBefore(declaration.source)?.value === FROM_KEYWORD;

export const importsOnlyTypes = (declaration: ESTree.ImportDeclaration, sourceCode: SourceCode) =>
  declaration.importKind === "type" ||
  importsEmptyBraces(declaration, sourceCode) ||
  (declaration.specifiers.length > 0 &&
    declaration.specifiers.every(
      (specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type",
    ));

export const propertyKeyName = (property: ESTree.Node) => {
  if (property.type !== "Property") {
    return;
  }
  const { computed, key } = property;
  const isUncomputedIdentifierKey = !computed && key.type === "Identifier";
  return isUncomputedIdentifierKey ? key.name : staticKeyName(key);
};

export const effectOperation = (node: ESTree.Node, sourceCode: SourceCode) =>
  effectModuleOperation(node, sourceCode, "Effect");

const LINE_BREAKS = /\r\n|[\n\r]/gu;

const LINE_BREAK = String.raw`\n`;

const onOneLine = (text: string) => text.replace(LINE_BREAKS, LINE_BREAK);

export const importedBindingOf = (expression: ESTree.Node, sourceCode: SourceCode) => {
  const value = unwrappedExpression(expression);
  const isMember = value.type === "MemberExpression";
  const binding = isMember ? value.object : value;
  if (binding.type !== "Identifier") {
    return;
  }
  const imported = importedExpression(binding, sourceCode);
  if (imported === undefined) {
    return;
  }
  if (!isMember) {
    return { name: binding.name, member: undefined, module: imported.module };
  }
  return memberName(value) === undefined
    ? undefined
    : {
        name: binding.name,
        member: onOneLine(sourceCode.getText(value)),
        module: imported.module,
      };
};

export const isImportBinding = (node: ESTree.Node, sourceCode: SourceCode) =>
  resolvedVariable(node, sourceCode)?.defs[0]?.node.parent?.type === "ImportDeclaration";
