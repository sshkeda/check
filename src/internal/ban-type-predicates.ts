import type { Context, CreateRule, ESTree, SourceCode } from "@oxlint/plugins";
import { Schema } from "effect";

import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import { effectModuleOperation } from "./resolve-what-an-expression-imports.ts";

const SCHEMA_DECLARATIONS = ["banned", "allowed"] as const;

const TYPE_PREDICATE_OPTIONS = Schema.Struct({
  schemaDeclarations: Schema.optionalKey(Schema.Literals(SCHEMA_DECLARATIONS)),
});

const SCHEMA_DECLARATION_OPERATIONS = new Set(["declare", "declareConstructor"]);

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

const isSchemaDeclarationCall = (call: ESTree.CallExpression, sourceCode: SourceCode) => {
  const target = call.callee.type === "CallExpression" ? call.callee.callee : call.callee;
  const operation = effectModuleOperation(target, sourceCode, "Schema");
  return operation !== undefined && SCHEMA_DECLARATION_OPERATIONS.has(operation);
};

const isFunctionReturnType = (predicate: ESTree.TSTypePredicate) => {
  const annotation = predicate.parent;
  return annotation.parent !== null && FUNCTIONS.has(annotation.parent.type);
};

const isSchemaDeclarationCallback = (predicate: ESTree.TSTypePredicate, sourceCode: SourceCode) => {
  const callback = predicate.parent.parent;
  const isCallback =
    callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression";
  if (!isCallback) {
    return false;
  }
  const call = callback.parent;
  return (
    call.type === "CallExpression" &&
    call.arguments.some((argument) => argument === callback) &&
    isSchemaDeclarationCall(call, sourceCode)
  );
};

export const noTypePredicates = {
  meta: {
    type: "problem",
    messages: {
      typePredicate: "`{{predicate}}` is an unchecked type predicate",
    },
    schema: ruleOptionsJsonSchema(TYPE_PREDICATE_OPTIONS),
  },
  create(context: Pick<Context, "options" | "report" | "sourceCode">) {
    const schemaDeclarations =
      decodeRuleOptions(TYPE_PREDICATE_OPTIONS, context.options)?.schemaDeclarations ?? "banned";
    return {
      TSTypePredicate(node) {
        const isLeftUnreported =
          !isFunctionReturnType(node) ||
          (schemaDeclarations === "allowed" &&
            isSchemaDeclarationCallback(node, context.sourceCode));
        if (isLeftUnreported) {
          return;
        }
        context.report({
          node,
          messageId: "typePredicate",
          data: { predicate: context.sourceCode.getText(node) },
        });
      },
    };
  },
} satisfies CreateRule;
