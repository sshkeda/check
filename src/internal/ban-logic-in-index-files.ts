import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { fileNameOf, isEntryFileName } from "../shared/match-file-names-and-path-prefixes.ts";
import { resolvedVariable } from "./resolve-what-an-expression-imports.ts";

const WORD_START = /(?<!^)(?=[A-Z][a-z])/gu;
const ACRONYM = /^[A-Z]+$/u;
const VOWEL_SOUND_START = /^(?:[aeio]|up)/u;
const UNDEFINED = "undefined";
const EXPORTABLE_DECLARATIONS: ReadonlySet<string> = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSImportEqualsDeclaration",
]);
const WIRING_STATEMENTS: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "TSImportEqualsDeclaration",
  "ExportAllDeclaration",
  "TSNamespaceExportDeclaration",
]);
const CONSTANT = "const";
const METHOD_KINDS = { get: "a getter", set: "a setter" } as const;

const kindOf = (node: ESTree.Node) => {
  if (node.type === "TSModuleDeclaration") {
    return `a ${node.kind} declaration`;
  }
  const words = node.type
    .replace(WORD_START, " ")
    .split(" ")
    .map((word) => (ACRONYM.test(word) ? word : word.toLowerCase()))
    .join(" ");
  return `${VOWEL_SOUND_START.test(words) ? "an" : "a"} ${words}`;
};

const isNegativeNumber = (node: ESTree.Node) =>
  node.type === "UnaryExpression" &&
  node.operator === "-" &&
  node.argument.type === "Literal" &&
  (typeof node.argument.value === "number" || typeof node.argument.value === "bigint");

const partsOf = (node: ESTree.Node) => {
  const isTypeScriptWrapper =
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSInstantiationExpression";
  if (isTypeScriptWrapper) {
    return [node.expression];
  }
  const isCallOrNew = node.type === "CallExpression" || node.type === "NewExpression";
  if (isCallOrNew) {
    return [node.callee, ...node.arguments];
  }
  if (node.type === "MemberExpression") {
    return node.computed ? [node.object, node.property] : [node.object];
  }
  if (node.type === "Property") {
    return node.computed ? [node.key, node.value] : [node.value];
  }
  if (node.type === "TemplateLiteral") {
    return node.expressions;
  }
  if (node.type === "ArrayExpression") {
    return node.elements;
  }
  if (node.type === "ObjectExpression") {
    return node.properties;
  }
  return node.type === "SpreadElement" ? [node.argument] : undefined;
};

export const noIndexLogic = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Keep index.ts and index.tsx to wiring.",
    },
    messages: {
      holds: "index file holds {{kind}}",
      outsideAnExport: "index file holds {{kind}} outside an export statement",
      readsGlobal: "index file reads the global {{name}}",
    },
  },
  create(context) {
    if (!isEntryFileName(fileNameOf(context.filename))) {
      return {};
    }
    const reportHeld = (node: ESTree.Node, kind = kindOf(node)) => {
      context.report({ node, messageId: "holds", data: { kind } });
    };
    const checkExpression = (node: ESTree.Node | null): void => {
      const isLiteralValue = node === null || node.type === "Literal" || isNegativeNumber(node);
      if (isLiteralValue) {
        return;
      }
      if (node.type === "Identifier") {
        const variable = resolvedVariable(node, context.sourceCode);
        const isOwnBinding = node.name === UNDEFINED || (variable?.defs.length ?? 0) > 0;
        if (!isOwnBinding) {
          context.report({ node, messageId: "readsGlobal", data: { name: node.name } });
        }
        return;
      }
      if (node.type === "Property") {
        const isMethodLike = node.method || node.kind !== "init";
        if (isMethodLike) {
          reportHeld(node, node.kind === "init" ? "a method" : METHOD_KINDS[node.kind]);
          return;
        }
      }
      const parts = partsOf(node);
      if (parts === undefined) {
        reportHeld(node);
      } else {
        for (const part of parts) {
          checkExpression(part);
        }
      }
    };
    const checkDeclaration = (node: ESTree.Node) => {
      if (node.type !== "VariableDeclaration") {
        if (!EXPORTABLE_DECLARATIONS.has(node.type)) {
          reportHeld(node);
        }
        return;
      }
      if (node.kind !== CONSTANT) {
        reportHeld(node, `a ${node.kind} declaration`);
        return;
      }
      for (const declarator of node.declarations) {
        if (declarator.id.type === "Identifier") {
          checkExpression(declarator.init);
        } else {
          reportHeld(declarator.id);
        }
      }
    };
    const checkStatement = (node: ESTree.Directive | ESTree.Statement) => {
      if (WIRING_STATEMENTS.has(node.type)) {
        return;
      }
      const isDeclaration = node.type.endsWith("Declaration") || node.type === "TSDeclareFunction";
      if (node.type === "ExportNamedDeclaration") {
        if (node.declaration !== null) {
          checkDeclaration(node.declaration);
        }
      } else if (node.type === "ExportDefaultDeclaration") {
        const exported = node.declaration;
        const isFunctionOrClass =
          exported.type === "FunctionDeclaration" || exported.type === "ClassDeclaration";
        if (isFunctionOrClass) {
          reportHeld(exported);
        } else if (exported.type !== "TSInterfaceDeclaration") {
          checkExpression(exported);
        }
      } else if (node.type === "ExpressionStatement") {
        checkExpression(node.expression);
      } else if (node.type === "TSExportAssignment") {
        checkExpression(node.expression);
      } else if (isDeclaration) {
        context.report({ node, messageId: "outsideAnExport", data: { kind: kindOf(node) } });
      } else {
        reportHeld(node);
      }
    };
    return {
      Program(program) {
        for (const statement of program.body) {
          checkStatement(statement);
        }
      },
    };
  },
});
