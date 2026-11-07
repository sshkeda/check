import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  importedExpression,
  isGlobalReference,
  staticKeyName,
  typeNameParts,
  typeNameRoot,
} from "./resolve-what-an-expression-imports.ts";

const FAILING_TYPES = new Set([
  "Effect.Effect",
  "Effect.fn.Return",
  "Effect.gen.Return",
  "Exit.Exit",
  "Stream.Stream",
  "Layer.Layer",
]);

const FAILURE_TYPE_ARGUMENT = 1;

const GLOBAL_ERROR = "Error";

const GLOBAL_OBJECT = "globalThis";

const UNNAMED = "this type";

const effectModulePath = (module: string) => {
  if (module === "effect") {
    return [];
  }
  return module.startsWith("effect/") ? [module.slice("effect/".length)] : undefined;
};

const effectTypePath = (reference: ESTree.TSTypeReference, sourceCode: SourceCode) => {
  const imported = importedExpression(typeNameRoot(reference.typeName), sourceCode);
  const modulePath = imported && effectModulePath(imported.module);
  const isOutsideEffect = imported === undefined || modulePath === undefined;
  if (isOutsideEffect) {
    return;
  }
  return [...modulePath, ...imported.members, ...typeNameParts(reference.typeName).slice(1)].join(
    ".",
  );
};

const isGlobalError = (type: ESTree.Node, sourceCode: SourceCode) => {
  if (type.type !== "TSTypeReference") {
    return false;
  }
  const { typeName } = type;
  if (typeName.type === "TSQualifiedName") {
    return (
      typeName.right.name === GLOBAL_ERROR &&
      isGlobalReference(typeName.left, sourceCode, GLOBAL_OBJECT)
    );
  }
  return isGlobalReference(typeName, sourceCode, GLOBAL_ERROR);
};

const failureMembers = (type: ESTree.Node): readonly ESTree.Node[] => {
  if (type.type === "TSParenthesizedType") {
    return failureMembers(type.typeAnnotation);
  }
  return type.type === "TSUnionType" ? type.types.flatMap(failureMembers) : [type];
};

const keyName = (key: ESTree.Node, computed: boolean) => {
  const isUncomputedIdentifier = !computed && key.type === "Identifier";
  return isUncomputedIdentifier ? key.name : staticKeyName(key);
};

const declaredName = (node: ESTree.Node): string | undefined => {
  const isAnnotatedBinding =
    node.type === "Identifier" && node.typeAnnotation !== undefined && node.typeAnnotation !== null;
  if (isAnnotatedBinding) {
    return node.name;
  }
  if (node.type === "TSTypeAliasDeclaration") {
    return node.id.name;
  }
  if (node.type === "VariableDeclarator") {
    return node.id.type === "Identifier" ? node.id.name : undefined;
  }
  const isFunction =
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TSDeclareFunction";
  if (isFunction) {
    return node.id?.name;
  }
  const isKeyedMember =
    node.type === "TSPropertySignature" ||
    node.type === "TSMethodSignature" ||
    node.type === "PropertyDefinition" ||
    node.type === "MethodDefinition" ||
    node.type === "Property";
  return isKeyedMember ? keyName(node.key, node.computed) : undefined;
};

const enclosingName = (node: ESTree.Node): string => {
  const name = declaredName(node);
  if (name !== undefined) {
    return name;
  }
  const isStatement = node.type.endsWith("Statement") || node.type === "Program";
  const hasEnclosingNode = node.parent !== null && !isStatement;
  return hasEnclosingNode ? enclosingName(node.parent) : UNNAMED;
};

export const noPlainErrorFailures = defineRule({
  meta: {
    type: "problem",
    messages: {
      plainError: "{{name}} fails with Error",
    },
  },
  create(context) {
    return {
      TSTypeReference(reference) {
        const failure = reference.typeArguments?.params[FAILURE_TYPE_ARGUMENT];
        const isFailingType =
          failure !== undefined &&
          FAILING_TYPES.has(effectTypePath(reference, context.sourceCode) ?? "");
        if (!isFailingType) {
          return;
        }
        for (const member of failureMembers(failure)) {
          if (isGlobalError(member, context.sourceCode)) {
            context.report({
              node: member,
              messageId: "plainError",
              data: { name: enclosingName(reference) },
            });
          }
        }
      },
    };
  },
});
