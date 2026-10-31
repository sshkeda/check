import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { serviceFactoryOf } from "./match-effect-service-factories.ts";

const isServiceFactoryCall = (expression: ESTree.Node, sourceCode: SourceCode): boolean =>
  expression.type === "CallExpression"
    ? isServiceFactoryCall(expression.callee, sourceCode)
    : serviceFactoryOf(expression, sourceCode) !== undefined;

const staticKeySuffix = (expression: ESTree.Node | undefined): string | undefined => {
  if (expression?.type === "Literal") {
    const value = expression.value;
    if (typeof value === "string") {
      return value.split("/").at(-1);
    }
  }
  if (expression?.type === "TemplateLiteral") {
    const ending = expression.quasis.at(-1)?.value.cooked;
    const hasStaticLastSegment = expression.expressions.length === 0 || ending?.includes("/");
    if (hasStaticLastSegment === true) {
      return ending?.split("/").at(-1);
    }
  }
  return undefined;
};

export const noMismatchedServiceKeys = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require Effect service keys to end with their class name." },
    messages: {
      key: "the service key ends with {{suffix}}, not {{className}}",
      unknownKey: "the service key of {{className}} has no static last segment",
    },
  },
  create(context) {
    const checkClass = (declaration: ESTree.Node) => {
      const isClassDeclarationOrExpression =
        declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression";
      if (!isClassDeclarationOrExpression) {
        return;
      }
      const parent = declaration.superClass;
      if (parent?.type !== "CallExpression") {
        return;
      }
      if (!isServiceFactoryCall(parent.callee, context.sourceCode)) {
        return;
      }
      if (declaration.id === null) {
        return;
      }
      const suffix = staticKeySuffix(parent.arguments[0]);
      const className = declaration.id.name;
      if (suffix === undefined) {
        context.report({ node: parent, messageId: "unknownKey", data: { className } });
      } else if (suffix !== className) {
        context.report({ node: parent, messageId: "key", data: { suffix, className } });
      }
    };
    return { ClassDeclaration: checkClass, ClassExpression: checkClass };
  },
});
