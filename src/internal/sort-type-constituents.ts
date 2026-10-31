import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const GROUPS = [
  ["TSArrayType", "TSIndexedAccessType", "TSInferType", "TSTypeReference", "TSQualifiedName"],
  [
    "TSAnyKeyword",
    "TSBigIntKeyword",
    "TSBooleanKeyword",
    "TSNeverKeyword",
    "TSNumberKeyword",
    "TSObjectKeyword",
    "TSStringKeyword",
    "TSSymbolKeyword",
    "TSThisType",
    "TSUnknownKeyword",
    "TSIntrinsicKeyword",
  ],
  ["TSTypeOperator", "TSTypeQuery"],
  ["TSLiteralType", "TSTemplateLiteralType"],
  ["TSConstructorType", "TSFunctionType"],
  ["TSImportType"],
  ["TSConditionalType"],
  ["TSMappedType", "TSTypeLiteral"],
  ["TSTupleType"],
  ["TSIntersectionType"],
  ["TSUnionType"],
  ["TSNullKeyword", "TSUndefinedKeyword", "TSVoidKeyword"],
] as const;

const unparenthesized = (node: ESTree.TSType): ESTree.TSType =>
  node.type === "TSParenthesizedType" ? unparenthesized(node.typeAnnotation) : node;

const groupOf = (node: ESTree.TSType) =>
  GROUPS.findIndex((group) => group.some((kind) => kind === unparenthesized(node).type));

const typeParentOf = (
  node: ESTree.TSIntersectionType | ESTree.TSParenthesizedType | ESTree.TSUnionType,
): ESTree.Node =>
  node.parent.type === "TSParenthesizedType" ? typeParentOf(node.parent) : node.parent;

export const noUnsortedTypeConstituents = defineRule({
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      notSorted: "{{type}} type constituents must be sorted",
      notSortedNamed: "{{type}} type {{name}} constituents must be sorted",
    },
  },
  create(context) {
    const compare = (left: ESTree.TSType, right: ESTree.TSType) => {
      const leftText = context.sourceCode.getText(unparenthesized(left));
      const rightText = context.sourceCode.getText(unparenthesized(right));
      return (
        groupOf(left) - groupOf(right) ||
        leftText.localeCompare(rightText, "en", { numeric: true, sensitivity: "base" }) ||
        (leftText < rightText ? -1 : Number(leftText > rightText))
      );
    };
    const check = (node: ESTree.TSIntersectionType | ESTree.TSUnionType) => {
      const isSorted = node.types.every((constituent, index) => {
        const previous = node.types[index - 1];
        return previous === undefined || compare(previous, constituent) <= 0;
      });
      if (isSorted) {
        return;
      }
      const parent = typeParentOf(node);
      const alias = parent.type === "TSTypeAliasDeclaration" ? parent : undefined;
      context.report({
        node,
        messageId: alias === undefined ? "notSorted" : "notSortedNamed",
        data: {
          type: node.type === "TSUnionType" ? "Union" : "Intersection",
          name: alias?.id.name ?? "",
        },
      });
    };
    return { TSUnionType: check, TSIntersectionType: check };
  },
});
