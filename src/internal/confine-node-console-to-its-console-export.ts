import type { Context, CreateRule, ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

import {
  equivalentModuleSpecifiers,
  REPLACES_THE_CONSOLE,
} from "../shared/bans-each-permission-lifts.ts";
import { CONSOLE_REPLACED } from "../shared/record-and-grant-permissions-by-path.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import {
  importsOnlyTypes,
  moduleExportName,
  staticKeyName,
} from "./resolve-what-an-expression-imports.ts";

const NODE_CONSOLE = "node:console";
const CONSOLE_EXPORT = "Console";
const NODE_CONSOLE_SPECIFIERS: ReadonlySet<string> = new Set(
  equivalentModuleSpecifiers(NODE_CONSOLE),
);

const NODE_CONSOLE_OPTIONS = Schema.Struct({
  console: Schema.optionalKey(Schema.Literal(CONSOLE_REPLACED)),
});

const isTheConsoleExport = (specifier: ESTree.ImportDeclaration["specifiers"][number]) =>
  specifier.type === "ImportSpecifier" && moduleExportName(specifier.imported) === CONSOLE_EXPORT;

export const noNodeConsole = {
  meta: {
    type: "problem",
    messages: {
      outsideTheGrant: `${CONSOLE_EXPORT} from {{module}} is used outside a file allowed ${REPLACES_THE_CONSOLE}`,
      forbiddenForm: `{{module}} is imported in a way no file may. A file allowed ${REPLACES_THE_CONSOLE} may import only ${CONSOLE_EXPORT} from ${NODE_CONSOLE}`,
    },
    schema: ruleOptionsJsonSchema(NODE_CONSOLE_OPTIONS),
  },
  create(context: Pick<Context, "options" | "report" | "sourceCode">) {
    const isGranted =
      decodeRuleOptions(NODE_CONSOLE_OPTIONS, context.options)?.console === CONSOLE_REPLACED;
    const report = (source: ESTree.Node, module: string, isTheConsoleOnly: boolean) => {
      if (!isTheConsoleOnly) {
        context.report({ node: source, messageId: "forbiddenForm", data: { module } });
        return;
      }
      if (!isGranted) {
        context.report({ node: source, messageId: "outsideTheGrant", data: { module } });
      }
    };
    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        const isNodeConsoleWithValues =
          NODE_CONSOLE_SPECIFIERS.has(node.source.value) &&
          !importsOnlyTypes(node, context.sourceCode);
        if (!isNodeConsoleWithValues) {
          return;
        }
        const valueSpecifiers = node.specifiers.filter(
          (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
        );
        report(
          node.source,
          node.source.value,
          valueSpecifiers.length > 0 &&
            valueSpecifiers.every((specifier) => isTheConsoleExport(specifier)),
        );
      },
      ImportExpression(node: ESTree.ImportExpression) {
        const module = staticKeyName(node.source);
        const loadsNodeConsole = module !== undefined && NODE_CONSOLE_SPECIFIERS.has(module);
        if (loadsNodeConsole) {
          report(node.source, module, false);
        }
      },
    };
  },
} satisfies CreateRule;
