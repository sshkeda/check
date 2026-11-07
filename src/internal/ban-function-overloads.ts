import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const unexported = (member: ESTree.Node) => {
  const isExport =
    member.type === "ExportNamedDeclaration" || member.type === "ExportDefaultDeclaration";
  if (!isExport) {
    return member;
  }
  return member.declaration ?? member;
};

const methodName = (
  method: {
    readonly kind: ESTree.MethodDefinition["kind"] | ESTree.TSMethodSignature["kind"];
    readonly key: ESTree.Node;
  },
  nameOf: (key: ESTree.Node) => string,
) => {
  if (method.kind === "constructor") {
    return "the constructor";
  }
  return method.kind === "method" ? nameOf(method.key) : `${method.kind} ${nameOf(method.key)}`;
};

const namedFunctionMember = (
  member: ESTree.Node,
  nameOf: (key: ESTree.Node) => string,
): { readonly name: string; readonly isSignature: boolean } | undefined => {
  const declaration = unexported(member);
  const isFunction =
    declaration.type === "TSDeclareFunction" || declaration.type === "FunctionDeclaration";
  if (isFunction) {
    return {
      name: declaration.id?.name ?? "the default export",
      isSignature: declaration.type === "TSDeclareFunction",
    };
  }
  const isClassMethod =
    declaration.type === "MethodDefinition" || declaration.type === "TSAbstractMethodDefinition";
  if (isClassMethod) {
    return {
      name: `${declaration.static ? "static " : ""}${methodName(declaration, nameOf)}`,
      isSignature: declaration.value.type === "TSEmptyBodyFunctionExpression",
    };
  }
  if (declaration.type === "TSMethodSignature") {
    return { name: methodName(declaration, nameOf), isSignature: true };
  }
  if (declaration.type === "TSCallSignatureDeclaration") {
    return { name: "the call signature", isSignature: true };
  }
  return declaration.type === "TSConstructSignatureDeclaration"
    ? { name: "the construct signature", isSignature: true }
    : undefined;
};

export const noOverloads = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      overload: "{{name}} is overloaded",
    },
  },
  create(context) {
    const reportOverloads = (members: readonly ESTree.Node[]) => {
      const declarationsByName = Map.groupBy(
        members.flatMap((member) => {
          const named = namedFunctionMember(member, (key) => context.sourceCode.getText(key));
          return named === undefined ? [] : [{ member, ...named }];
        }),
        (declaration) => declaration.name,
      );
      for (const [name, declarations] of declarationsByName) {
        if (declarations.length > 1) {
          for (const { member } of declarations.filter((declaration) => declaration.isSignature)) {
            context.report({ node: member, messageId: "overload", data: { name } });
          }
        }
      }
    };
    return {
      Program: (node) => {
        reportOverloads(node.body);
      },
      TSModuleBlock: (node) => {
        reportOverloads(node.body);
      },
      BlockStatement: (node) => {
        reportOverloads(node.body);
      },
      ClassBody: (node) => {
        reportOverloads(node.body);
      },
      TSInterfaceBody: (node) => {
        reportOverloads(node.body);
      },
      TSTypeLiteral: (node) => {
        reportOverloads(node.members);
      },
    };
  },
});
