import type { Context, CreateRule, ESTree } from "@oxlint/plugins";

import { EFFECT_OPERATION_RULES } from "../shared/lint-rule-messages-and-patterns.ts";
import { effectModuleOperation, moduleExportName } from "./resolve-what-an-expression-imports.ts";

const EFFECT_SUBPATH = "effect/";

const operationsByModule = (operations: Readonly<Record<string, readonly string[]>>) =>
  new Map(
    Object.entries(operations).map(([moduleName, names]) => [moduleName, new Set(names)] as const),
  );

export const effectOperationRule = (ruleName: keyof typeof EFFECT_OPERATION_RULES) => {
  const rule = EFFECT_OPERATION_RULES[ruleName];
  const bannedOperations = [["operation", operationsByModule(rule.operations)]] as const;
  const bannedModules: ReadonlySet<string> = new Set(
    bannedOperations.flatMap(([, operations]) => [...operations.keys()]),
  );
  return {
    meta: {
      type: "problem",
      messages: {
        operation: "{{moduleName}}.{{operation}} is banned",
      },
    },
    create(context: Pick<Context, "report" | "sourceCode">) {
      const report = (node: ESTree.Node, moduleName: string, operation: string | undefined) => {
        if (operation === undefined) {
          return;
        }
        const banned = bannedOperations.find(
          ([, operations]) => operations.get(moduleName)?.has(operation) === true,
        );
        if (banned !== undefined) {
          context.report({ node, messageId: banned[0], data: { moduleName, operation } });
        }
      };
      return {
        MemberExpression(node) {
          for (const moduleName of bannedModules) {
            report(node, moduleName, effectModuleOperation(node, context.sourceCode, moduleName));
          }
        },
        ImportDeclaration(node) {
          const moduleName = node.source.value.startsWith(EFFECT_SUBPATH)
            ? node.source.value.slice(EFFECT_SUBPATH.length)
            : undefined;
          const isValueImportOfABannedModule =
            node.importKind !== "type" && moduleName !== undefined && bannedModules.has(moduleName);
          if (!isValueImportOfABannedModule) {
            return;
          }
          for (const specifier of node.specifiers) {
            const isValueSpecifier =
              specifier.type === "ImportSpecifier" && specifier.importKind !== "type";
            if (isValueSpecifier) {
              report(specifier, moduleName, moduleExportName(specifier.imported));
            }
          }
        },
      };
    },
  } satisfies CreateRule;
};
