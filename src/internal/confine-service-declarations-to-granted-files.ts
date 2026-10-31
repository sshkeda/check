import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import { serviceFactoryOf } from "./match-effect-service-factories.ts";

const SERVICE_OPTIONS = Schema.Struct({
  services: Schema.optionalKey(Schema.Array(Schema.String)),
});

const serviceNameAbove = (
  child: ESTree.Node,
  ancestor: ESTree.Node | null | undefined,
): string | undefined => {
  if (!ancestor) {
    return undefined;
  }
  const isClass = ancestor.type === "ClassDeclaration" || ancestor.type === "ClassExpression";
  if (isClass) {
    if (ancestor.superClass === child) {
      return ancestor.id?.name;
    }
    return undefined;
  }
  if (ancestor.type === "VariableDeclarator") {
    return ancestor.id.type === "Identifier" ? ancestor.id.name : undefined;
  }
  const passesTheFactoryThrough =
    ancestor.type === "CallExpression" ||
    ancestor.type === "MemberExpression" ||
    ancestor.type === "TSInstantiationExpression";
  if (!passesTheFactoryThrough) {
    return undefined;
  }
  return serviceNameAbove(ancestor, ancestor.parent);
};

const declaredServiceName = (factory: ESTree.Node) => serviceNameAbove(factory, factory.parent);

const grantedServices = (options: readonly unknown[]) =>
  decodeRuleOptions(SERVICE_OPTIONS, options)?.services;

export const noServiceDeclarations = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Declare Effect services only in files granted them by exact name with lintConfig({ [file]: { services: [names] } }).",
    },
    messages: {
      service: "Context.{{factory}} declares service {{name}} outside a services file",
      anonymousService: "Context.{{factory}} declares a service outside a services file",
      unlisted: "Context.{{factory}} declares unlisted service {{name}}",
      unnamed: "Context.{{factory}} declares a service without a class name",
    },
    schema: ruleOptionsJsonSchema(SERVICE_OPTIONS),
  },
  create(context) {
    const granted = grantedServices(context.options);
    const checkFactory = (node: ESTree.Node) => {
      const factory = serviceFactoryOf(node, context.sourceCode);
      if (factory === undefined) {
        return;
      }
      const name = declaredServiceName(node);
      if (granted === undefined) {
        context.report(
          name === undefined
            ? { node, messageId: "anonymousService", data: { factory } }
            : { node, messageId: "service", data: { factory, name } },
        );
      } else if (name === undefined) {
        context.report({ node, messageId: "unnamed", data: { factory } });
      } else if (!granted.includes(name)) {
        context.report({ node, messageId: "unlisted", data: { factory, name } });
      }
    };
    return { MemberExpression: checkFactory, Identifier: checkFactory };
  },
});

export const noUnusedServiceGrants = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Declare every service a file is granted in lintConfig.",
    },
    messages: {
      missing: "granted service {{name}} is not declared here",
    },
    schema: ruleOptionsJsonSchema(SERVICE_OPTIONS),
  },
  create(context) {
    const granted = grantedServices(context.options) ?? [];
    const declared = new Set<string>();
    const recordFactory = (node: ESTree.Node) => {
      const name =
        serviceFactoryOf(node, context.sourceCode) === undefined
          ? undefined
          : declaredServiceName(node);
      if (name !== undefined) {
        declared.add(name);
      }
    };
    return {
      MemberExpression: recordFactory,
      Identifier: recordFactory,
      "Program:exit"(node) {
        for (const name of granted.filter((candidate) => !declared.has(candidate))) {
          context.report({ node, messageId: "missing", data: { name } });
        }
      },
    };
  },
});
