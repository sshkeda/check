import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { inEnglish } from "./ban-abbreviated-words-in-declared-names.ts";

const CONSTANT_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

const isConstAssertion = (node: ESTree.Node) =>
  node.type === "TSAsExpression" &&
  node.typeAnnotation.type === "TSTypeReference" &&
  node.typeAnnotation.typeName.type === "Identifier" &&
  node.typeAnnotation.typeName.name === "const";

const isScalarLiteral = (node: ESTree.Node): boolean => {
  if (node.type === "Literal") {
    return !("regex" in node);
  }
  if (node.type === "Identifier") {
    return node.name === "undefined";
  }
  if (node.type === "TemplateLiteral") {
    return node.expressions.length === 0;
  }
  return (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "Literal" &&
    typeof node.argument.value === "number"
  );
};

const isFixedLiteral = (node: ESTree.Node): boolean => {
  if (isScalarLiteral(node)) {
    return true;
  }
  if (node.type === "ArrayExpression") {
    return node.elements.every(
      (element) => element !== null && element.type !== "SpreadElement" && isFixedLiteral(element),
    );
  }
  if (node.type === "ObjectExpression") {
    return node.properties.every(
      (property) =>
        property.type === "Property" &&
        property.kind === "init" &&
        !property.computed &&
        !property.method &&
        !property.shorthand &&
        isFixedLiteral(property.value),
    );
  }
  return false;
};

const literalUnder = (initializer: ESTree.Node): ESTree.Node => {
  const isSatisfiesOrConstAssertion =
    initializer.type === "TSSatisfiesExpression" ||
    (initializer.type === "TSAsExpression" && isConstAssertion(initializer));
  return isSatisfiesOrConstAssertion ? literalUnder(initializer.expression) : initializer;
};

const endsInAsConst = (initializer: ESTree.Node): boolean =>
  isConstAssertion(initializer) ||
  (initializer.type === "TSSatisfiesExpression" && endsInAsConst(initializer.expression));

const isModuleScope = (declaration: ESTree.VariableDeclaration) =>
  declaration.parent.type === "Program" ||
  (declaration.parent.type === "ExportNamedDeclaration" &&
    declaration.parent.parent.type === "Program");

const isEmptyCollection = (node: ESTree.Node) =>
  (node.type === "ObjectExpression" && node.properties.length === 0) ||
  (node.type === "ArrayExpression" && node.elements.length === 0);

const MUTABLE_COLLECTION_TYPES = new Set(["Array", "Record"]);

const isMutableCollectionType = (annotation: ESTree.TSType) =>
  annotation.type === "TSArrayType" ||
  annotation.type === "TSTypeLiteral" ||
  (annotation.type === "TSTypeReference" &&
    annotation.typeName.type === "Identifier" &&
    MUTABLE_COLLECTION_TYPES.has(annotation.typeName.name));

export const noLooseLiteralConstants = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      constant: "const {{name}} {{violations}}",
    },
  },
  create(context) {
    return {
      VariableDeclarator(declarator) {
        const declaration = declarator.parent;
        const id = declarator.id;
        const initializer = declarator.init;
        if (declaration.type !== "VariableDeclaration") {
          return;
        }
        const isInitializedConstName =
          declaration.kind === "const" && id.type === "Identifier" && initializer !== null;
        if (!isInitializedConstName) {
          return;
        }
        const name = id.name;
        const literal = literalUnder(initializer);
        const isCollection =
          literal.type === "ArrayExpression" || literal.type === "ObjectExpression";
        const annotation = id.typeAnnotation?.typeAnnotation;
        const isMutableAccumulator =
          annotation !== undefined &&
          isMutableCollectionType(annotation) &&
          isEmptyCollection(literal) &&
          !endsInAsConst(initializer);
        const isFixed =
          isModuleScope(declaration) && isFixedLiteral(literal) && !isMutableAccumulator;
        const isAnnotatedNonAccumulatorCollection =
          annotation !== undefined && isCollection && !isMutableAccumulator;
        const isFixedButNotConstantCase = isFixed && !CONSTANT_CASE.test(name);
        const isFixedCollectionWithoutAsConst =
          isFixed && isCollection && !endsInAsConst(initializer);
        const violations = [
          ...(isAnnotatedNonAccumulatorCollection ? ["has a type annotation"] : []),
          ...(isFixedButNotConstantCase ? ["is not in CAPITAL_SNAKE_CASE"] : []),
          ...(isFixedCollectionWithoutAsConst ? ["does not end in as const"] : []),
        ];
        if (violations.length > 0) {
          context.report({
            node: id,
            messageId: "constant",
            data: { name, violations: inEnglish(violations) },
          });
        }
      },
    };
  },
});
