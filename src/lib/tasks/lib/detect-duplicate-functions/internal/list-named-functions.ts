import { parseSync, Visitor } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  BindingPattern,
  BindingProperty,
  BindingRestElement,
  Class,
  Directive,
  Expression,
  ForStatementInit,
  Function as FunctionNode,
  JSXElementName,
  Node,
  ParamPattern,
  Statement,
} from "oxc-parser";

const IMPLICIT_ARGUMENTS = "arguments";
const OWN_THIS = "this";
const INTRINSIC_TAG = /^[a-z]|-/u;

const withoutParentheses = (expression: Expression): Expression =>
  expression.type === "ParenthesizedExpression"
    ? withoutParentheses(expression.expression)
    : expression;

const isFunctionAssignedTo = (assigned: Expression | null) => {
  const unwrapped = assigned === null ? undefined : withoutParentheses(assigned);
  return unwrapped?.type === "ArrowFunctionExpression" || unwrapped?.type === "FunctionExpression";
};

const bindingNamesOf = (
  pattern: BindingPattern | BindingProperty | BindingRestElement | ParamPattern | null,
): readonly string[] => {
  if (pattern === null) {
    return [];
  }
  if (pattern.type === "Identifier") {
    return [pattern.name];
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => bindingNamesOf(property));
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => bindingNamesOf(element));
  }
  if (pattern.type === "AssignmentPattern") {
    return bindingNamesOf(pattern.left);
  }
  if (pattern.type === "RestElement") {
    return bindingNamesOf(pattern.argument);
  }
  if (pattern.type === "Property") {
    return bindingNamesOf(pattern.value);
  }
  return bindingNamesOf(pattern.parameter);
};

const lexicalNamesDeclaredBy = (statement: Directive | ForStatementInit | Statement | null) => {
  const isLexicalDeclaration =
    statement?.type === "VariableDeclaration" && statement.kind !== "var";
  if (isLexicalDeclaration) {
    return statement.declarations.flatMap((declarator) => bindingNamesOf(declarator.id));
  }
  if (statement?.type === "FunctionDeclaration") {
    return statement.id === null ? [] : [statement.id.name];
  }
  if (statement?.type === "ClassDeclaration") {
    return statement.id === null ? [] : [statement.id.name];
  }
  return statement?.type === "TSEnumDeclaration" ? [statement.id.name] : [];
};

const varNamesIn = (
  statement: Directive | ForStatementInit | Statement | null,
): readonly string[] => {
  if (statement === null) {
    return [];
  }
  if (statement.type === "VariableDeclaration") {
    return statement.kind === "var"
      ? statement.declarations.flatMap((declarator) => bindingNamesOf(declarator.id))
      : [];
  }
  if (statement.type === "BlockStatement") {
    return statement.body.flatMap((inner) => varNamesIn(inner));
  }
  if (statement.type === "IfStatement") {
    return [...varNamesIn(statement.consequent), ...varNamesIn(statement.alternate)];
  }
  if (statement.type === "ForStatement") {
    return [...varNamesIn(statement.init), ...varNamesIn(statement.body)];
  }
  const isForInOrOf = statement.type === "ForInStatement" || statement.type === "ForOfStatement";
  if (isForInOrOf) {
    const left = statement.left.type === "VariableDeclaration" ? varNamesIn(statement.left) : [];
    return [...left, ...varNamesIn(statement.body)];
  }
  const isLoopOrLabel =
    statement.type === "WhileStatement" ||
    statement.type === "DoWhileStatement" ||
    statement.type === "LabeledStatement";
  if (isLoopOrLabel) {
    return varNamesIn(statement.body);
  }
  if (statement.type === "TryStatement") {
    return [
      ...varNamesIn(statement.block),
      ...(statement.handler === null ? [] : varNamesIn(statement.handler.body)),
      ...varNamesIn(statement.finalizer),
    ];
  }
  return statement.type === "SwitchStatement"
    ? statement.cases.flatMap(({ consequent }) => consequent.flatMap((inner) => varNamesIn(inner)))
    : [];
};

const componentRootOf = (name: JSXElementName): string | undefined => {
  if (name.type === "JSXMemberExpression") {
    return name.object.type === "JSXIdentifier" ? name.object.name : componentRootOf(name.object);
  }
  if (name.type === "JSXNamespacedName") {
    return undefined;
  }
  return INTRINSIC_TAG.test(name.name) ? undefined : name.name;
};

export const namedFunctionsIn = (path: string, text: string) => {
  const named: { name: string; start: number; end: number; code: Node }[] = [];
  const scopes: { names: ReadonlySet<string>; isInAFunction: boolean }[] = [];
  const open: { name: string; code: Node; depth: number; readsAnEnclosingLocal: boolean }[] = [];
  const typePositions: Node[] = [];
  const propertyNames = new Set<Node>();
  const caseScopes = new Map<Node, readonly string[]>();
  const enterScope = (names: readonly string[], isAFunction = false) => {
    scopes.push({
      names: new Set(names),
      isInAFunction: isAFunction || scopes.at(-1)?.isInAFunction === true,
    });
  };
  const leaveScope = () => {
    scopes.pop();
  };
  const read = (name: string) => {
    if (typePositions.length > 0) {
      return;
    }
    const owner = scopes.findLastIndex(({ names }) => names.has(name));
    const isAFunctionLocal = owner !== -1 && scopes[owner]?.isInAFunction === true;
    if (!isAFunctionLocal) {
      return;
    }
    for (const candidate of open) {
      const isCapturedByCandidate = owner < candidate.depth && name !== candidate.name;
      if (isCapturedByCandidate) {
        candidate.readsAnEnclosingLocal = true;
      }
    }
  };
  const openFunction = (name: string, code: Node) => {
    open.push({ name, code, depth: scopes.length, readsAnEnclosingLocal: false });
  };
  const closeFunction = (code: Node) => {
    const candidate = open.at(-1);
    if (candidate?.code !== code) {
      return;
    }
    open.pop();
    if (!candidate.readsAnEnclosingLocal) {
      named.push({ name: candidate.name, start: code.start, end: code.end, code });
    }
  };
  const enterFunction = (node: ArrowFunctionExpression | FunctionNode) => {
    const { id } = node;
    const isANamedExpression = node.type === "FunctionExpression" && id !== null;
    const ownName = isANamedExpression ? [id.name] : [];
    const implicitBindings =
      node.type === "ArrowFunctionExpression" ? [] : [IMPLICIT_ARGUMENTS, OWN_THIS];
    const hoisted =
      node.body?.type === "BlockStatement"
        ? node.body.body.flatMap((statement) => varNamesIn(statement))
        : [];
    enterScope(
      [
        ...ownName,
        ...implicitBindings,
        ...node.params.flatMap((parameter) => bindingNamesOf(parameter)),
        ...hoisted,
      ],
      true,
    );
  };
  const enterClass = (node: Class) => {
    enterScope(node.id === null ? [] : [node.id.name]);
  };
  const enterTypePosition = (node: Node) => {
    typePositions.push(node);
  };
  const leaveTypePosition = () => {
    typePositions.pop();
  };
  const ignoreKey = (node: { computed: boolean; key: Node }) => {
    if (!node.computed) {
      propertyNames.add(node.key);
    }
  };
  new Visitor({
    FunctionDeclaration(node) {
      const { id: declared, body } = node;
      const isNamedWithBody = declared !== null && body !== null;
      if (isNamedWithBody) {
        openFunction(declared.name, node);
      }
      enterFunction(node);
    },
    "FunctionDeclaration:exit"(node) {
      leaveScope();
      closeFunction(node);
    },
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": leaveScope,
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": leaveScope,
    VariableDeclarator(node) {
      const declared = node.id;
      const isNamedFunction = declared.type === "Identifier" && isFunctionAssignedTo(node.init);
      if (isNamedFunction) {
        openFunction(declared.name, node);
      }
    },
    "VariableDeclarator:exit": closeFunction,
    ClassExpression: enterClass,
    "ClassExpression:exit": leaveScope,
    BlockStatement(node) {
      enterScope(node.body.flatMap((statement) => lexicalNamesDeclaredBy(statement)));
    },
    "BlockStatement:exit": leaveScope,
    StaticBlock(node) {
      enterScope([
        ...node.body.flatMap((statement) => lexicalNamesDeclaredBy(statement)),
        ...node.body.flatMap((statement) => varNamesIn(statement)),
      ]);
    },
    "StaticBlock:exit": leaveScope,
    SwitchStatement(node) {
      const [firstCase] = node.cases;
      if (firstCase !== undefined) {
        caseScopes.set(
          firstCase,
          node.cases.flatMap(({ consequent }) =>
            consequent.flatMap((statement) => lexicalNamesDeclaredBy(statement)),
          ),
        );
      }
    },
    SwitchCase(node) {
      const names = caseScopes.get(node);
      if (names !== undefined) {
        enterScope(names);
      }
    },
    "SwitchStatement:exit"(node) {
      if (node.cases.length > 0) {
        leaveScope();
      }
    },
    ForStatement(node) {
      enterScope(lexicalNamesDeclaredBy(node.init));
    },
    "ForStatement:exit": leaveScope,
    ForInStatement(node) {
      enterScope(node.left.type === "VariableDeclaration" ? lexicalNamesDeclaredBy(node.left) : []);
    },
    "ForInStatement:exit": leaveScope,
    ForOfStatement(node) {
      enterScope(node.left.type === "VariableDeclaration" ? lexicalNamesDeclaredBy(node.left) : []);
    },
    "ForOfStatement:exit": leaveScope,
    CatchClause(node) {
      enterScope(bindingNamesOf(node.param));
    },
    "CatchClause:exit": leaveScope,
    TSEnumBody(node) {
      enterScope(
        node.members.flatMap(({ id }) => {
          if (id.type === "Identifier") {
            return [id.name];
          }
          return id.type === "Literal" ? [id.value] : [];
        }),
      );
    },
    "TSEnumBody:exit": leaveScope,
    TSEnumMember(node) {
      propertyNames.add(node.id);
    },
    MemberExpression(node) {
      if (!node.computed) {
        propertyNames.add(node.property);
      }
    },
    Property: ignoreKey,
    MethodDefinition: ignoreKey,
    PropertyDefinition: ignoreKey,
    AccessorProperty: ignoreKey,
    TSAbstractAccessorProperty: ignoreKey,
    TSAbstractMethodDefinition: ignoreKey,
    TSAbstractPropertyDefinition: ignoreKey,
    TSPropertySignature: ignoreKey,
    TSMethodSignature: ignoreKey,
    MetaProperty(node) {
      propertyNames.add(node.meta);
      propertyNames.add(node.property);
    },
    LabeledStatement(node) {
      propertyNames.add(node.label);
    },
    BreakStatement(node) {
      if (node.label !== null) {
        propertyNames.add(node.label);
      }
    },
    ContinueStatement(node) {
      if (node.label !== null) {
        propertyNames.add(node.label);
      }
    },
    TSTypeAnnotation: enterTypePosition,
    "TSTypeAnnotation:exit": leaveTypePosition,
    TSTypeAliasDeclaration: enterTypePosition,
    "TSTypeAliasDeclaration:exit": leaveTypePosition,
    TSInterfaceDeclaration: enterTypePosition,
    "TSInterfaceDeclaration:exit": leaveTypePosition,
    TSTypeParameterDeclaration: enterTypePosition,
    "TSTypeParameterDeclaration:exit": leaveTypePosition,
    TSTypeParameterInstantiation: enterTypePosition,
    "TSTypeParameterInstantiation:exit": leaveTypePosition,
    TSTypeReference: enterTypePosition,
    "TSTypeReference:exit": leaveTypePosition,
    TSTypeQuery: enterTypePosition,
    "TSTypeQuery:exit": leaveTypePosition,
    TSClassImplements: enterTypePosition,
    "TSClassImplements:exit": leaveTypePosition,
    TSFunctionType: enterTypePosition,
    "TSFunctionType:exit": leaveTypePosition,
    TSConstructorType: enterTypePosition,
    "TSConstructorType:exit": leaveTypePosition,
    TSMappedType: enterTypePosition,
    "TSMappedType:exit": leaveTypePosition,
    TSIndexSignature: enterTypePosition,
    "TSIndexSignature:exit": leaveTypePosition,
    TSTypePredicate: enterTypePosition,
    "TSTypePredicate:exit": leaveTypePosition,
    TSImportType: enterTypePosition,
    "TSImportType:exit": leaveTypePosition,
    TSCallSignatureDeclaration: enterTypePosition,
    "TSCallSignatureDeclaration:exit": leaveTypePosition,
    TSConstructSignatureDeclaration: enterTypePosition,
    "TSConstructSignatureDeclaration:exit": leaveTypePosition,
    TSArrayType: enterTypePosition,
    "TSArrayType:exit": leaveTypePosition,
    TSConditionalType: enterTypePosition,
    "TSConditionalType:exit": leaveTypePosition,
    TSDeclareFunction: enterTypePosition,
    "TSDeclareFunction:exit": leaveTypePosition,
    TSEmptyBodyFunctionExpression: enterTypePosition,
    "TSEmptyBodyFunctionExpression:exit": leaveTypePosition,
    TSIndexedAccessType: enterTypePosition,
    "TSIndexedAccessType:exit": leaveTypePosition,
    TSInferType: enterTypePosition,
    "TSInferType:exit": leaveTypePosition,
    TSInterfaceHeritage: enterTypePosition,
    "TSInterfaceHeritage:exit": leaveTypePosition,
    TSIntersectionType: enterTypePosition,
    "TSIntersectionType:exit": leaveTypePosition,
    TSLiteralType: enterTypePosition,
    "TSLiteralType:exit": leaveTypePosition,
    TSNamedTupleMember: enterTypePosition,
    "TSNamedTupleMember:exit": leaveTypePosition,
    TSOptionalType: enterTypePosition,
    "TSOptionalType:exit": leaveTypePosition,
    TSParenthesizedType: enterTypePosition,
    "TSParenthesizedType:exit": leaveTypePosition,
    TSRestType: enterTypePosition,
    "TSRestType:exit": leaveTypePosition,
    TSTemplateLiteralType: enterTypePosition,
    "TSTemplateLiteralType:exit": leaveTypePosition,
    TSThisType: enterTypePosition,
    "TSThisType:exit": leaveTypePosition,
    TSTupleType: enterTypePosition,
    "TSTupleType:exit": leaveTypePosition,
    TSTypeLiteral: enterTypePosition,
    "TSTypeLiteral:exit": leaveTypePosition,
    TSTypeOperator: enterTypePosition,
    "TSTypeOperator:exit": leaveTypePosition,
    TSTypeParameter: enterTypePosition,
    "TSTypeParameter:exit": leaveTypePosition,
    TSUnionType: enterTypePosition,
    "TSUnionType:exit": leaveTypePosition,
    JSXOpeningElement(node) {
      const component = componentRootOf(node.name);
      if (component !== undefined) {
        read(component);
      }
    },
    ThisExpression() {
      read(OWN_THIS);
    },
    Identifier(node) {
      if (!propertyNames.has(node)) {
        read(node.name);
      }
    },
  }).visit(parseSync(path, text, { astType: "ts" }).program);
  return named.toSorted((first, second) => first.start - second.start);
};
