import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  everyBanOf,
  MODULE_PATTERN_WILDCARD,
  moduleSpecifiersOfGlobalObject,
  PERMISSION_BANS,
} from "../shared/bans-each-permission-lifts.ts";
import { bansByKind, modulePatternMatcher } from "./match-banned-modules-and-globals.ts";
import {
  importedExpression,
  isGlobalReference,
  isImportBinding,
  isReferencePosition,
  isShorthandKey,
  memberName,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const EFFECT_PACKAGE = /^(?:effect|@effect\/[^/]+)(?:\/|$)/u;
const MODULE_FILE = /\/[A-Z]\w*$/u;
const MODULE_NAME = /^[A-Z]/u;
const LINE_BREAKS = /\s*(?:\r\n|[\n\r])\s*/gu;

const isEffectModule = (imported: NonNullable<ReturnType<typeof importedExpression>>) => {
  if (!EFFECT_PACKAGE.test(imported.module)) {
    return false;
  }
  if (MODULE_FILE.test(imported.module)) {
    return imported.members.length === 0;
  }
  const [first, ...rest] = imported.members;
  return first === undefined || (rest.length === 0 && MODULE_NAME.test(first));
};

const NAMESPACES_OF_IMPORT_BANS = Object.values(PERMISSION_BANS)
  .flatMap((entry) => bansByKind(everyBanOf(entry)).imports)
  .filter(({ modulePattern }) => modulePattern !== MODULE_PATTERN_WILDCARD)
  .map(({ modulePattern, importNames }) => ({
    matchesModule: modulePatternMatcher(modulePattern),
    importPaths: importNames.map((name) => name.split(".")),
  }));

const isNamespaceOfABannedImport = (imported: NonNullable<ReturnType<typeof importedExpression>>) =>
  NAMESPACES_OF_IMPORT_BANS.some(
    ({ matchesModule, importPaths }) =>
      matchesModule(imported.module) &&
      importPaths.some(
        (path) =>
          path.length > imported.members.length &&
          imported.members.every((member, index) => path[index] === member),
      ),
  );

const namesAnImportDirectly = (node: ESTree.Node, sourceCode: SourceCode): boolean => {
  const expression = unwrappedExpression(node);
  return expression.type === "MemberExpression"
    ? namesAnImportDirectly(expression.object, sourceCode)
    : isImportBinding(expression, sourceCode);
};

const typeScriptWrapperOf = (node: ESTree.Node) => {
  const { parent } = node;
  const isTypeScriptWrapper =
    parent?.type === "TSAsExpression" ||
    parent?.type === "TSSatisfiesExpression" ||
    parent?.type === "TSTypeAssertion" ||
    parent?.type === "TSNonNullExpression";
  const wrapsTheNode = isTypeScriptWrapper && parent.expression === node;
  return wrapsTheNode ? parent : undefined;
};

const OBJECT_KEYS = "keys";

const isAllowedNamespaceUse = (node: ESTree.Node, sourceCode: SourceCode) => {
  const { parent } = node;
  if (parent === null) {
    return false;
  }
  const isObjectOfAMember = parent.type === "MemberExpression" && parent.object === node;
  if (isObjectOfAMember) {
    return memberName(parent) !== undefined;
  }
  const isCalledOrConstructed =
    (parent.type === "CallExpression" || parent.type === "NewExpression") && parent.callee === node;
  const isTypeOfOperand = parent.type === "UnaryExpression" && parent.operator === "typeof";
  const isListedByObjectKeys =
    parent.type === "CallExpression" &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === node &&
    parent.callee.type === "MemberExpression" &&
    memberName(parent.callee) === OBJECT_KEYS &&
    isGlobalReference(parent.callee.object, sourceCode, "Object");
  const isInstanceOfTarget =
    parent.type === "BinaryExpression" && parent.operator === "instanceof" && parent.right === node;
  return isCalledOrConstructed || isTypeOfOperand || isInstanceOfTarget || isListedByObjectKeys;
};

export const noNamespaceAliases = (globalObjects: ReadonlySet<string>) => {
  const isGlobalObject = (node: ESTree.Node, sourceCode: SourceCode) => {
    const isGlobalObjectReference =
      node.type === "Identifier" &&
      globalObjects.has(node.name) &&
      isGlobalReference(node, sourceCode, node.name);
    if (isGlobalObjectReference) {
      return true;
    }
    const imported = namesAnImportDirectly(node, sourceCode)
      ? importedExpression(node, sourceCode)
      : undefined;
    if (imported?.members.length !== 0) {
      return false;
    }
    return [...globalObjects].some((globalObject) =>
      moduleSpecifiersOfGlobalObject(globalObject).includes(imported.module),
    );
  };
  return defineRule({
    meta: {
      type: "problem",
      docs: {
        description: `Use an Effect module, a module or namespace a permission ban names members of, or one of the globals ${[...globalObjects].join(", ")}, only through a named member, so no alias, destructuring or spread hides a banned member from the rules that ban it.`,
      },
      messages: {
        wholeNamespace:
          "{{name}} is used without naming a member, so the bans on its members can't see which one runs",
      },
    },
    create(context) {
      const { sourceCode } = context;
      const isNamespace = (node: ESTree.Node) => {
        if (isGlobalObject(node, sourceCode)) {
          return true;
        }
        const imported = namesAnImportDirectly(node, sourceCode)
          ? importedExpression(node, sourceCode)
          : undefined;
        return (
          imported !== undefined &&
          (isEffectModule(imported) || isNamespaceOfABannedImport(imported))
        );
      };
      const report = (node: ESTree.Node) => {
        const isNamespaceUsedWhole = isNamespace(node) && !isAllowedNamespaceUse(node, sourceCode);
        if (isNamespaceUsedWhole) {
          context.report({
            node,
            messageId: "wholeNamespace",
            data: { name: sourceCode.getText(node).replace(LINE_BREAKS, " ") },
          });
        }
      };
      return {
        Identifier(node) {
          const isObjectOfAMember =
            node.parent.type === "MemberExpression" && node.parent.object === node;
          const isReference =
            isObjectOfAMember ||
            typeScriptWrapperOf(node) !== undefined ||
            (isReferencePosition(node) && !isShorthandKey(node));
          if (isReference) {
            report(node);
          }
        },
        MemberExpression(node) {
          const receiver = unwrappedExpression(node.object);
          const isWrappedNamespace = receiver !== node.object && isNamespace(receiver);
          if (!isWrappedNamespace) {
            report(node);
          }
        },
      };
    },
  });
};
