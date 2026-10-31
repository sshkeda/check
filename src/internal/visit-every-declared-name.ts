import type { ESTree, Visitor } from "@oxlint/plugins";

const isExternalPropertyName = (property: ESTree.Node) => {
  if (property.type !== "Property") {
    return false;
  }
  if (property.computed) {
    return false;
  }
  if (property.key.type !== "Identifier") {
    return false;
  }
  const value = property.value.type === "AssignmentPattern" ? property.value.left : property.value;
  return value.type === "Identifier" && value.name === property.key.name;
};

const bindingsIn = (scope: "every" | "own") => {
  const bindings = (pattern: ESTree.Node | null): readonly ESTree.Node[] => {
    if (pattern === null) {
      return [];
    }
    if (pattern.type === "Identifier") {
      return [pattern];
    }
    if (pattern.type === "ObjectPattern") {
      return pattern.properties
        .filter((property) => scope === "every" || !isExternalPropertyName(property))
        .flatMap((property) =>
          property.type === "RestElement" ? bindings(property.argument) : bindings(property.value),
        );
    }
    if (pattern.type === "ArrayPattern") {
      return pattern.elements.flatMap(bindings);
    }
    if (pattern.type === "RestElement") {
      return bindings(pattern.argument);
    }
    if (pattern.type === "AssignmentPattern") {
      return bindings(pattern.left);
    }
    if (pattern.type === "TSParameterProperty") {
      return bindings(pattern.parameter);
    }
    return [];
  };
  return bindings;
};

const named = (key: ESTree.Node, computed: boolean) => {
  const isUncomputedName =
    !computed && (key.type === "Identifier" || key.type === "PrivateIdentifier");
  return isUncomputedName ? [key] : [];
};

const referencedTypeNames = (type: ESTree.Node): readonly string[] => {
  if (type.type === "TSTypeReference") {
    return referencedTypeNames(type.typeName);
  }
  if (type.type === "TSQualifiedName") {
    return [...referencedTypeNames(type.left), ...referencedTypeNames(type.right)];
  }
  if (type.type === "Identifier") {
    return [type.name];
  }
  if (type.type === "TSArrayType") {
    return referencedTypeNames(type.elementType);
  }
  if (type.type === "TSTypeOperator") {
    return referencedTypeNames(type.typeAnnotation);
  }
  if (type.type === "TSImportType") {
    return type.qualifier === null ? [] : referencedTypeNames(type.qualifier);
  }
  return [];
};

const programOf = (node: ESTree.Node): ESTree.Node =>
  node.parent === null ? node : programOf(node.parent);

const memberNamesOfLocalInterface = (program: ESTree.Node, interfaceName: string) => {
  if (program.type !== "Program") {
    return;
  }
  const declaration = program.body
    .map((statement) =>
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement,
    )
    .find(
      (statement) =>
        statement?.type === "TSInterfaceDeclaration" && statement.id.name === interfaceName,
    );
  if (declaration?.type !== "TSInterfaceDeclaration") {
    return;
  }
  return new Set(
    declaration.body.body.flatMap((member) => {
      const isPropertyOrMethodSignature =
        member.type === "TSPropertySignature" || member.type === "TSMethodSignature";
      if (!isPropertyOrMethodSignature) {
        return [];
      }
      const { computed, key } = member;
      const isUncomputedIdentifierKey = !computed && key.type === "Identifier";
      return isUncomputedIdentifierKey ? [key.name] : [];
    }),
  );
};

const INTERFACES_WITHOUT_LOCAL_DECLARATIONS_NEED_TYPE_INFORMATION = true;

const isInterfaceMember = (
  member: ESTree.AccessorProperty | ESTree.MethodDefinition | ESTree.PropertyDefinition,
) => {
  const body = member.parent;
  const owner = body.type === "ClassBody" ? body.parent : undefined;
  if (member.computed) {
    return false;
  }
  if (member.key.type !== "Identifier") {
    return false;
  }
  const isOwnedByAClass = owner?.type === "ClassDeclaration" || owner?.type === "ClassExpression";
  if (!isOwnedByAClass) {
    return false;
  }
  const memberName = member.key.name;
  return (owner.implements ?? []).some((heritage) => {
    const declared =
      heritage.expression.type === "Identifier"
        ? memberNamesOfLocalInterface(programOf(member), heritage.expression.name)
        : undefined;
    return declared === undefined
      ? INTERFACES_WITHOUT_LOCAL_DECLARATIONS_NEED_TYPE_INFORMATION
      : declared.has(memberName);
  });
};

export const declaredNameListeners = (
  check: (node: ESTree.Node, inheritedNames?: readonly string[]) => void,
  scope: Parameters<typeof bindingsIn>[0] = "every",
) => {
  const bindings = bindingsIn(scope);
  const isOwnMember = (
    member: ESTree.AccessorProperty | ESTree.MethodDefinition | ESTree.PropertyDefinition,
  ) => scope === "every" || !isInterfaceMember(member);

  const each = (nodes: readonly ESTree.Node[]) => {
    for (const node of nodes) {
      check(node);
    }
  };

  const property = (node: ESTree.AccessorProperty | ESTree.PropertyDefinition) => {
    const isOwnNonOverridingProperty = node.override !== true && isOwnMember(node);
    if (isOwnNonOverridingProperty) {
      each(named(node.key, node.computed));
    }
  };

  const parameters = (
    node:
      | ESTree.ArrowFunctionExpression
      | ESTree.Function
      | ESTree.TSCallSignatureDeclaration
      | ESTree.TSConstructSignatureDeclaration
      | ESTree.TSFunctionType
      | ESTree.TSMethodSignature,
  ) => {
    each(node.params.flatMap(bindings));
  };

  const declared = (node: { readonly id: ESTree.Node | null }) => {
    each(bindings(node.id));
  };

  return {
    VariableDeclarator(node) {
      declared(node);
    },
    FunctionDeclaration(node) {
      declared(node);
      parameters(node);
    },
    FunctionExpression(node) {
      declared(node);
      parameters(node);
    },
    ArrowFunctionExpression(node) {
      parameters(node);
    },
    TSDeclareFunction(node) {
      declared(node);
      parameters(node);
    },
    TSFunctionType(node) {
      parameters(node);
    },
    TSCallSignatureDeclaration(node) {
      parameters(node);
    },
    TSConstructSignatureDeclaration(node) {
      parameters(node);
    },
    TSMethodSignature(node) {
      each(named(node.key, node.computed));
      parameters(node);
    },
    TSPropertySignature(node) {
      each(named(node.key, node.computed));
    },
    ClassDeclaration(node) {
      declared(node);
    },
    ClassExpression(node) {
      declared(node);
    },
    MethodDefinition(node) {
      const isOwnNonOverridingMethod =
        node.override !== true && node.kind !== "constructor" && isOwnMember(node);
      if (isOwnNonOverridingMethod) {
        each(named(node.key, node.computed));
      }
    },
    PropertyDefinition(node) {
      property(node);
    },
    AccessorProperty(node) {
      property(node);
    },
    TSInterfaceDeclaration(node) {
      declared(node);
    },
    TSTypeAliasDeclaration(node) {
      check(node.id, referencedTypeNames(node.typeAnnotation));
    },
    TSEnumDeclaration(node) {
      declared(node);
    },
    TSEnumMember(node) {
      if (node.id.type === "Identifier") {
        check(node.id);
      }
    },
    TSTypeParameter(node) {
      check(node.name);
    },
    CatchClause(node) {
      each(bindings(node.param));
    },
    ImportDefaultSpecifier(node) {
      check(node.local);
    },
    ImportNamespaceSpecifier(node) {
      check(node.local);
    },
    ImportSpecifier(node) {
      const importsUnderADifferentLocalName =
        node.imported.type !== "Identifier" || node.imported.name !== node.local.name;
      if (importsUnderADifferentLocalName) {
        check(node.local);
      }
    },
  } satisfies Visitor;
};
