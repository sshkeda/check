import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { FORMAT_CONFIG_BINDING, FORMAT_CONFIG_FILE } from "../shared/config-file-names.ts";
import {
  fileNameOf,
  INTERNAL_DIRECTORY_NAME,
  isEntryFileName,
  LIBRARY_DIRECTORY_NAME,
  SHARED_DIRECTORY_NAME,
} from "../shared/match-file-names-and-path-prefixes.ts";
import {
  DEFAULT_EXPORT,
  importedBindingOf,
  importedExpression,
  resolvedVariable,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const OWN_LAYOUT_DIRECTORIES = `${INTERNAL_DIRECTORY_NAME}/ and ${SHARED_DIRECTORY_NAME}/`;
const RE_EXPORTABLE_EXTENSIONS = ".ts or .tsx";

export const noReExports = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: `Define each export where it is written; an exception is an index.ts or index.tsx that re-exports names, unrenamed, with export { … } from or export type { … } from a path that resolves to a ${RE_EXPORTABLE_EXTENSIONS} file, not an index or a .d.ts, directly in its own ${OWN_LAYOUT_DIRECTORIES}. An index.ts may also export * as Name from the index.ts of a module directly in its own ${LIBRARY_DIRECTORY_NAME}/ that only re-exports unrenamed names from its own internal files. export { … } or export default naming an imported binding, or export default of a direct static member of an imported binding, is a re-export too, and so is an exported declaration initialized to one of them. ${FORMAT_CONFIG_FILE} may export default the imported ${FORMAT_CONFIG_BINDING}, which the format-config check requires. The re-exports check judges where an index's export from and export * as resolve.`,
    },
    messages: {
      fromModule: "export from {{source}} re-exports another module",
      everything: "export * from {{source}} re-exports another module",
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
  },
  create(context) {
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
            const isLeftToTheReExportsCheck = isIndexFile && statement.exported !== null;
            if (isLeftToTheReExportsCheck) {
              continue;
            }
            context.report({
              node: statement,
              messageId: "everything",
              data: { source: statement.source.value },
            });
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
            if (!exportsTheFormatConfig) {
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
