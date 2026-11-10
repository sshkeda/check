import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

import { FORMAT_CONFIG_BINDING, FORMAT_CONFIG_FILE } from "../shared/config-file-names.ts";
import { fileNameOf, isEntryFileName } from "../shared/match-file-names-and-path-prefixes.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import {
  DEFAULT_EXPORT,
  importedBindingOf,
  importedExpression,
  propertyKeyName,
  resolvedVariable,
  textOnOneLine,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const DEFAULT_EXPORTS_OF_IMPORTS = ["banned", "allowed"] as const;

const RE_EXPORTS_OPTIONS = Schema.Struct({
  defaultExportOfAnImport: Schema.optionalKey(Schema.Literals(DEFAULT_EXPORTS_OF_IMPORTS)),
});

export const noReExports = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      fromModule: "export from {{source}} re-exports another module",
      everything: "export * from {{source}} re-exports another module",
      namespace: "export * as {{name}} from {{source}} re-exports another module",
      importedValue: "export {{exported}} re-exports {{binding}}, imported from {{source}}",
      importedMember:
        "export {{exported}} re-exports {{member}}, a member of {{binding}} imported from {{source}}",
      initializedToImport:
        "export {{exported}} is initialized to {{binding}}, imported from {{source}}",
      initializedToMember:
        "export {{exported}} is initialized to {{member}}, a member of {{binding}} imported from {{source}}",
      importEquals: "export import {{name}} re-exports another module",
      exportAssignment: "export = replaces the module's exports",
    },
    schema: ruleOptionsJsonSchema(RE_EXPORTS_OPTIONS),
  },
  create(context) {
    const defaultExportOfAnImport =
      decodeRuleOptions(RE_EXPORTS_OPTIONS, context.options)?.defaultExportOfAnImport ?? "banned";
    const isIndexFile = isEntryFileName(fileNameOf(context.filename));
    const isFormatConfigFile = fileNameOf(context.filename) === FORMAT_CONFIG_FILE;
    const reportImport = (
      node: ESTree.Node,
      exported: string,
      imported: NonNullable<ReturnType<typeof importedBindingOf>>,
      bindingMessageId: "importedValue" | "initializedToImport",
      memberMessageId: "importedMember" | "initializedToMember",
    ) => {
      const { name: binding, module: source } = imported;
      context.report(
        imported.member === undefined
          ? { node, messageId: bindingMessageId, data: { exported, binding, source } }
          : {
              node,
              messageId: memberMessageId,
              data: { exported, binding, member: imported.member, source },
            },
      );
    };
    const localInitializerOf = (value: ESTree.Node) => {
      const definitions = resolvedVariable(unwrappedExpression(value), context.sourceCode)?.defs;
      const declarator = definitions?.length === 1 ? definitions[0]?.node : undefined;
      const isNamedDeclarator =
        declarator?.type === "VariableDeclarator" && declarator.id.type === "Identifier";
      return isNamedDeclarator ? (declarator.init ?? undefined) : undefined;
    };
    const reportInitializedToImport = (
      node: ESTree.Node,
      exported: string,
      initializer: ESTree.Node,
      followedInitializers: ReadonlySet<ESTree.Node> = new Set([initializer]),
    ) => {
      const imported = importedBindingOf(initializer, context.sourceCode);
      if (imported !== undefined) {
        reportImport(node, exported, imported, "initializedToImport", "initializedToMember");
        return;
      }
      const aliased = localInitializerOf(initializer);
      const isUnfollowedAlias = aliased !== undefined && !followedInitializers.has(aliased);
      if (isUnfollowedAlias) {
        reportInitializedToImport(
          node,
          exported,
          aliased,
          new Set([...followedInitializers, aliased]),
        );
      }
    };
    const reportDestructuredImport = (
      pattern: ESTree.ObjectPattern,
      imported: NonNullable<ReturnType<typeof importedBindingOf>>,
    ) => {
      const object = imported.member ?? imported.name;
      for (const property of pattern.properties) {
        const key = propertyKeyName(property);
        if (property.type !== "Property") {
          continue;
        }
        if (key === undefined) {
          continue;
        }
        const isNamedKey = !property.computed && property.key.type === "Identifier";
        const member = isNamedKey
          ? `${object}.${key}`
          : `${object}[${textOnOneLine(property.key, context.sourceCode)}]`;
        const { value } = property;
        if (value.type === "Identifier") {
          reportImport(
            property,
            value.name,
            { ...imported, member },
            "initializedToImport",
            "initializedToMember",
          );
        } else if (value.type === "ObjectPattern") {
          reportDestructuredImport(value, { ...imported, member });
        }
      }
    };
    const reportImported = (node: ESTree.Node, exported: string, value: ESTree.Node) => {
      const imported = importedBindingOf(value, context.sourceCode);
      if (imported !== undefined) {
        reportImport(node, exported, imported, "importedValue", "importedMember");
        return;
      }
      const initializer = localInitializerOf(value);
      if (initializer !== undefined) {
        reportInitializedToImport(node, exported, initializer);
      }
    };
    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type === "ExportAllDeclaration") {
            const source = statement.source.value;
            const isLeftToTheReExportsCheck = isIndexFile && statement.exported !== null;
            if (isLeftToTheReExportsCheck) {
              continue;
            }
            context.report(
              statement.exported === null
                ? { node: statement, messageId: "everything", data: { source } }
                : {
                    node: statement,
                    messageId: "namespace",
                    data: { name: context.sourceCode.getText(statement.exported), source },
                  },
            );
          } else if (statement.type === "ExportNamedDeclaration") {
            if (statement.source !== null) {
              if (!isIndexFile) {
                context.report({
                  node: statement,
                  messageId: "fromModule",
                  data: { source: statement.source.value },
                });
              }
              continue;
            }
            for (const specifier of statement.specifiers) {
              reportImported(
                specifier,
                context.sourceCode.getText(specifier.exported),
                specifier.local,
              );
            }
            const declaration = statement.declaration;
            if (declaration?.type === "VariableDeclaration") {
              for (const declarator of declaration.declarations) {
                const { id, init: initializer } = declarator;
                const isInitializedName = id.type === "Identifier" && initializer !== null;
                if (isInitializedName) {
                  reportInitializedToImport(declarator, id.name, initializer);
                }
                if (id.type === "ObjectPattern") {
                  const destructured =
                    initializer === null
                      ? undefined
                      : importedBindingOf(initializer, context.sourceCode);
                  if (destructured !== undefined) {
                    reportDestructuredImport(id, destructured);
                  }
                }
              }
            }
            const importsAModule =
              declaration?.type === "TSImportEqualsDeclaration" &&
              declaration.moduleReference.type === "TSExternalModuleReference";
            if (importsAModule) {
              context.report({
                node: declaration,
                messageId: "importEquals",
                data: { name: declaration.id.name },
              });
            }
          } else if (statement.type === "ExportDefaultDeclaration") {
            const exportsTheFormatConfig =
              isFormatConfigFile &&
              statement.declaration.type === "Identifier" &&
              statement.declaration.name === FORMAT_CONFIG_BINDING &&
              importedExpression(statement.declaration, context.sourceCode)?.members.join() ===
                FORMAT_CONFIG_BINDING;
            const isAllowedDefaultExport =
              exportsTheFormatConfig || defaultExportOfAnImport === "allowed";
            if (!isAllowedDefaultExport) {
              reportImported(statement, DEFAULT_EXPORT, statement.declaration);
            }
          } else if (statement.type === "TSExportAssignment") {
            context.report({ node: statement, messageId: "exportAssignment" });
          }
        }
      },
    };
  },
});
