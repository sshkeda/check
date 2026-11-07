import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { effectModuleOperation, staticKeyName } from "./resolve-what-an-expression-imports.ts";

const isUnknownAnnotation = (annotation: ESTree.TSTypeAnnotation | null | undefined) =>
  annotation?.typeAnnotation.type === "TSUnknownKeyword";

const annotatedParameter = (parameter: ESTree.Node) => {
  if (parameter.type === "TSParameterProperty") {
    return annotatedParameter(parameter.parameter);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.left.type === "Identifier"
      ? { identifier: parameter.left, annotation: parameter.left.typeAnnotation }
      : undefined;
  }
  if (parameter.type === "RestElement") {
    return parameter.argument.type === "Identifier"
      ? { identifier: parameter.argument, annotation: parameter.typeAnnotation }
      : undefined;
  }
  return parameter.type === "Identifier"
    ? { identifier: parameter, annotation: parameter.typeAnnotation }
    : undefined;
};

const isCallback = (node: ESTree.ArrowFunctionExpression | ESTree.Function) =>
  node.parent.type === "CallExpression" ||
  (node.parent.type === "Property" && node.parent.value === node);

const CLASS_MEMBERS: ReadonlySet<string> = new Set(["MethodDefinition", "PropertyDefinition"]);

const memberOfFunction = (node: Parameters<typeof isCallback>[0]) => {
  const parent = node.parent;
  const isMemberValue =
    (CLASS_MEMBERS.has(parent.type) || parent.type === "Property") &&
    "value" in parent &&
    parent.value === node;
  return isMemberValue ? parent : undefined;
};

const memberKeyName = (member: NonNullable<ReturnType<typeof memberOfFunction>>) => {
  const { computed, key } = member;
  const isUncomputedIdentifierKey = !computed && key.type === "Identifier";
  return isUncomputedIdentifierKey ? key.name : staticKeyName(key);
};

const reportedFunctionName = (node: Parameters<typeof isCallback>[0]) => {
  if (node.id) {
    return node.id.name;
  }
  const member = memberOfFunction(node);
  if (member !== undefined) {
    return memberKeyName(member) ?? "this function";
  }
  const parent = node.parent;
  if (parent.type !== "VariableDeclarator") {
    return "this function";
  }
  const declared = parent.id;
  return declared.type === "Identifier" ? declared.name : "this function";
};

const isExportedValue = (node: ESTree.Node) => {
  const parent = node.parent;
  if (parent?.type === "ExportDefaultDeclaration") {
    return true;
  }
  return (
    parent?.type === "VariableDeclarator" &&
    parent.init === node &&
    parent.parent.type === "VariableDeclaration" &&
    parent.parent.parent.type === "ExportNamedDeclaration"
  );
};

const isMemberOfAnExport = (member: NonNullable<ReturnType<typeof memberOfFunction>>) => {
  if (member.type === "Property") {
    return member.parent.type === "ObjectExpression" && isExportedValue(member.parent);
  }
  const isPrivate = member.accessibility === "private" || member.key.type === "PrivateIdentifier";
  if (isPrivate) {
    return false;
  }
  const owner = member.parent.parent;
  return (
    owner?.parent?.type === "ExportNamedDeclaration" || (owner !== null && isExportedValue(owner))
  );
};

const isDeclaredForExport = (node: Parameters<typeof isCallback>[0]) => {
  const isFunctionDeclaration =
    node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction";
  if (isFunctionDeclaration) {
    return true;
  }
  const member = memberOfFunction(node);
  return member === undefined ? isExportedValue(node) : isMemberOfAnExport(member);
};

export const noUnknownBoundaries = defineRule({
  meta: {
    type: "problem",
    messages: {
      parameter: "parameter {{name}} is typed unknown",
      returnType: "{{name}} returns unknown",
    },
  },
  create(context) {
    const isSchemaDecoder = (callee: ESTree.Node) => {
      const target = callee.type === "CallExpression" ? callee.callee : callee;
      const operation = effectModuleOperation(target, context.sourceCode, "Schema");
      return (
        operation !== undefined && (operation.startsWith("decodeUnknown") || operation === "is")
      );
    };

    const isDecodedRightAway = (
      node: Parameters<typeof isCallback>[0],
      identifier: ESTree.BindingIdentifier,
    ) => {
      const variable = context.sourceCode
        .getDeclaredVariables(node)
        .find((candidate) => candidate.name === identifier.name);
      const references = variable?.references ?? [];
      return (
        references.length > 0 &&
        references.every((reference) => {
          const parent = reference.identifier.parent;
          return (
            parent.type === "CallExpression" &&
            parent.arguments.some((argument) => argument === reference.identifier) &&
            isSchemaDecoder(parent.callee)
          );
        })
      );
    };

    const checkFunction = (node: Parameters<typeof isCallback>[0]) => {
      for (const parameter of node.params) {
        const annotated = annotatedParameter(parameter);
        if (annotated === undefined) {
          continue;
        }
        if (!isUnknownAnnotation(annotated.annotation)) {
          continue;
        }
        const isCauseParameterOfCallback =
          annotated.identifier.name === "cause" && isCallback(node);
        if (isCauseParameterOfCallback) {
          continue;
        }
        if (isDecodedRightAway(node, annotated.identifier)) {
          continue;
        }
        context.report({
          node: parameter,
          messageId: "parameter",
          data: { name: annotated.identifier.name },
        });
      }
      const { returnType } = node;
      const exportedFunctionReturnsUnknown =
        returnType?.typeAnnotation.type === "TSUnknownKeyword" && isDeclaredForExport(node);
      if (exportedFunctionReturnsUnknown) {
        const name = reportedFunctionName(node);
        context.report({ node: returnType, messageId: "returnType", data: { name } });
      }
    };

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      TSDeclareFunction: checkFunction,
    };
  },
});
