import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";
import { Schema } from "effect";

import { unusedGrantMessage } from "../shared/bans-each-permission-lifts.ts";
import {
  FIXED_FALLBACKS,
  FIXED_FALLBACKS_GRANTED,
} from "../shared/record-and-grant-permissions-by-path.ts";
import { isTagList, isTagText } from "./ban-fallbacks-of-named-recoveries.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import { stepsAfter, stepsAppliedTo } from "./follow-the-steps-applied-to-an-effect.ts";
import {
  fixedOutcomeOf,
  handlerFunction,
  returnedBranches,
  returnedValuesIn,
} from "./recognize-fixed-values.ts";
import { isWholeLibraryErrorTag } from "./recognize-whole-library-error-tags.ts";
import {
  constantValue,
  effectModuleOperation,
  effectOperation,
  memberName,
  propertyKeyName,
  resolvedVariable,
  staticKeyName,
  textOnOneLine,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const RECOVERY_MODULES = ["Effect", "Stream", "Channel"] as const;

const EVERY_FAILURE = "every failure";

const EVERY_CAUSE = "every cause";

const UNNAMED_FAILURES = "the failures it does not name";

const ON_FAILURE = "onFailure";

const CATCH = "catch";

const OPTION = "option";

const ALWAYS_FIXED_RECOVERY = "orElseSucceed";

const FALLBACK_AFTER_A_NAME_AND_A_HANDLER = 2;

const FALLBACK_AFTER_A_TAG_A_REASON_AND_A_HANDLER = 3;

const FIXED_FALLBACK_OPTIONS = Schema.Struct({
  fixedFallbacks: Schema.optionalKey(Schema.Literal(FIXED_FALLBACKS_GRANTED)),
});

const firstNamingArgument = (
  callArguments: readonly ESTree.Node[],
  isNaming: (node: ESTree.Node) => boolean,
  sourceCode: SourceCode,
) => {
  const [first] = callArguments;
  const isFirstNaming = first !== undefined && isNaming(constantValue(first, sourceCode));
  return isFirstNaming ? 0 : 1;
};

const tagNamesOf = (node: ESTree.Node | undefined, sourceCode: SourceCode) => {
  if (node === undefined) {
    return [];
  }
  const value = constantValue(node, sourceCode);
  const names =
    value.type === "ArrayExpression"
      ? value.elements.map((element) =>
          element === null ? undefined : staticKeyName(constantValue(element, sourceCode)),
        )
      : [staticKeyName(value)];
  return names.filter((name) => name !== undefined);
};

const handler = (node: ESTree.Node | undefined, failure: string) => {
  const isMissing = node === undefined || node.type === "SpreadElement";
  return isMissing ? [] : [{ node, failure }];
};

const effectiveProperties = (handlers: ESTree.Node | undefined, sourceCode: SourceCode) => {
  const value = handlers === undefined ? undefined : constantValue(handlers, sourceCode);
  if (value?.type !== "ObjectExpression") {
    return [];
  }
  return value.properties.flatMap((property, position) => {
    const key = propertyKeyName(property);
    const isOverridden = value.properties.slice(position + 1).some((later) => {
      const laterKey = propertyKeyName(later);
      return laterKey === undefined || laterKey === key;
    });
    const isEffective = key !== undefined && !isOverridden && property.type === "Property";
    return isEffective ? [{ key, value: property.value }] : [];
  });
};

const catchTagHandlers = (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) => {
  const offset = firstNamingArgument(callArguments, isTagList, sourceCode);
  const libraryTags = tagNamesOf(callArguments[offset], sourceCode).filter((tag) =>
    isWholeLibraryErrorTag(tag),
  );
  return [
    ...(libraryTags.length > 0 ? handler(callArguments[offset + 1], libraryTags.join(" or ")) : []),
    ...handler(callArguments[offset + FALLBACK_AFTER_A_NAME_AND_A_HANDLER], UNNAMED_FAILURES),
  ];
};

const catchTagsHandlers = (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) => {
  const offset = firstNamingArgument(
    callArguments,
    (node) => node.type === "ObjectExpression",
    sourceCode,
  );
  return [
    ...effectiveProperties(callArguments[offset], sourceCode)
      .filter(({ key }) => isWholeLibraryErrorTag(key))
      .flatMap(({ key, value }) => handler(value, key)),
    ...handler(callArguments[offset + 1], UNNAMED_FAILURES),
  ];
};

const catchReasonHandlers = (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) => {
  const offset = firstNamingArgument(callArguments, isTagText, sourceCode);
  return handler(
    callArguments[offset + FALLBACK_AFTER_A_TAG_A_REASON_AND_A_HANDLER],
    UNNAMED_FAILURES,
  );
};

const catchReasonsHandlers = (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) => {
  const offset = firstNamingArgument(callArguments, isTagText, sourceCode);
  return handler(callArguments[offset + FALLBACK_AFTER_A_NAME_AND_A_HANDLER], UNNAMED_FAILURES);
};

const lastHandlerFor = (failure: string) => (callArguments: readonly ESTree.Node[]) =>
  handler(callArguments.at(-1), failure);

const onFailureHandlersFor =
  (failure: string) => (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) =>
    effectiveProperties(callArguments.at(-1), sourceCode)
      .filter(({ key }) => key === ON_FAILURE)
      .flatMap(({ value }) => handler(value, failure));

const RECOVERIES: ReadonlyMap<
  string,
  (callArguments: readonly ESTree.Node[], sourceCode: SourceCode) => ReturnType<typeof handler>
> = new Map([
  ["catchTag", catchTagHandlers],
  ["catchTags", catchTagsHandlers],
  ["catchReason", catchReasonHandlers],
  ["catchReasons", catchReasonsHandlers],
  ["catch", lastHandlerFor(EVERY_FAILURE)],
  ["catchEager", lastHandlerFor(EVERY_FAILURE)],
  ["orElse", lastHandlerFor(EVERY_FAILURE)],
  ["catchCause", lastHandlerFor(EVERY_CAUSE)],
  ["match", onFailureHandlersFor(EVERY_FAILURE)],
  ["matchEager", onFailureHandlersFor(EVERY_FAILURE)],
  ["matchEffect", onFailureHandlersFor(EVERY_FAILURE)],
  ["matchCause", onFailureHandlersFor(EVERY_CAUSE)],
  ["matchCauseEager", onFailureHandlersFor(EVERY_CAUSE)],
  ["matchCauseEffect", onFailureHandlersFor(EVERY_CAUSE)],
  ["matchCauseEffectEager", onFailureHandlersFor(EVERY_CAUSE)],
]);

const boundNamesOf = (pattern: ESTree.Node | null): readonly ESTree.Node[] => {
  if (pattern === null) {
    return [];
  }
  if (pattern.type === "Identifier") {
    return [pattern];
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      boundNamesOf(property.type === "Property" ? property.value : property.argument),
    );
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => boundNamesOf(element));
  }
  if (pattern.type === "AssignmentPattern") {
    return boundNamesOf(pattern.left);
  }
  return pattern.type === "RestElement" ? boundNamesOf(pattern.argument) : [pattern];
};

const isRead = (binding: ESTree.Node, sourceCode: SourceCode) => {
  const variable = resolvedVariable(binding, sourceCode);
  return variable === undefined || variable.references.some((reference) => reference.isRead());
};

const ignoresTheFailure = (parameters: readonly ESTree.Node[], sourceCode: SourceCode) =>
  parameters
    .flatMap((parameter) => boundNamesOf(parameter))
    .every((binding) => !isRead(binding, sourceCode));

const parametersOf = (node: ESTree.Node, sourceCode: SourceCode) =>
  handlerFunction(node, sourceCode)?.params;

const fixedBranchesOf = (branches: readonly ESTree.Node[], sourceCode: SourceCode) =>
  branches.flatMap((branch) => {
    const value = fixedOutcomeOf(branch, sourceCode);
    return value === undefined ? [] : [{ branch, value }];
  });

const fixedBranchOf = (node: ESTree.Node, sourceCode: SourceCode) => {
  const parameters = parametersOf(node, sourceCode);
  const isIgnored = parameters !== undefined && ignoresTheFailure(parameters, sourceCode);
  return isIgnored ? fixedBranchesOf(returnedBranches(node, sourceCode), sourceCode)[0] : undefined;
};

const getOrElseDefault = (steps: ReturnType<typeof stepsAppliedTo>, sourceCode: SourceCode) => {
  const [next] = steps;
  const [mapped] = next?.callArguments ?? [];
  const isMappedOnce = next?.operation === "map" && next.callArguments.length === 1;
  const isMappedThroughOneFunction = isMappedOnce && mapped !== undefined;
  const getOrElse = isMappedThroughOneFunction ? constantValue(mapped, sourceCode) : undefined;
  const isGetOrElse =
    getOrElse?.type === "CallExpression" &&
    getOrElse.arguments.length === 1 &&
    effectModuleOperation(getOrElse.callee, sourceCode, "Option") === "getOrElse";
  return isGetOrElse ? getOrElse.arguments[0] : undefined;
};

const optionStepsOf = (node: ESTree.CallExpression, sourceCode: SourceCode) => {
  const isDataFirstOption =
    effectOperation(node.callee, sourceCode) === OPTION && node.arguments.length === 1;
  const bareOptions = node.arguments.filter(
    (argument) => effectOperation(argument, sourceCode) === OPTION,
  );
  return [
    ...(isDataFirstOption ? [stepsAppliedTo(node, sourceCode)] : []),
    ...bareOptions.map((argument) => stepsAfter(argument, sourceCode)),
  ];
};

export const noFixedFallbacks = defineRule({
  meta: {
    type: "problem",
    messages: {
      fixed:
        "{{operation}} answers {{failure}} with the fixed value {{value}} and never reads the failure",
      unusedGrant: unusedGrantMessage(FIXED_FALLBACKS),
    },
    schema: ruleOptionsJsonSchema(FIXED_FALLBACK_OPTIONS),
  },
  create(context) {
    const { sourceCode } = context;
    const options = decodeRuleOptions(FIXED_FALLBACK_OPTIONS, context.options);
    const isGranted = options?.fixedFallbacks === FIXED_FALLBACKS_GRANTED;
    const fixedFallbacks = new Set<ESTree.Node>();
    const reportFixed = (
      { branch, value }: { readonly branch: ESTree.Node; readonly value: ESTree.Node },
      data: { readonly operation: string; readonly failure: string },
    ) => {
      fixedFallbacks.add(branch);
      if (!isGranted) {
        context.report({
          node: branch,
          messageId: "fixed",
          data: { ...data, value: textOnOneLine(unwrappedExpression(value), sourceCode) },
        });
      }
    };
    const reportHandlers = (handlers: ReturnType<typeof handler>, operation: string) => {
      for (const recovery of handlers) {
        const fixed = fixedBranchOf(recovery.node, sourceCode);
        if (fixed !== undefined) {
          reportFixed(fixed, { operation, failure: recovery.failure });
        }
      }
    };
    const reportEffectRecovery = (node: ESTree.CallExpression) =>
      RECOVERY_MODULES.some((moduleName) => {
        const operation = effectModuleOperation(node.callee, sourceCode, moduleName);
        if (operation === undefined) {
          return false;
        }
        const recovery = RECOVERIES.get(operation);
        if (recovery !== undefined) {
          reportHandlers(recovery(node.arguments, sourceCode), `${moduleName}.${operation}`);
        }
        const fallback = node.arguments.at(-1);
        const isAlwaysFixed = operation === ALWAYS_FIXED_RECOVERY && fallback !== undefined;
        if (isAlwaysFixed) {
          const [returned = fallback] = returnedBranches(fallback, sourceCode);
          reportFixed(
            { branch: returned, value: returned },
            { operation: `${moduleName}.${operation}`, failure: EVERY_FAILURE },
          );
        }
        return true;
      });
    return {
      CallExpression(node) {
        const isEffectOperation = reportEffectRecovery(node);
        for (const steps of optionStepsOf(node, sourceCode)) {
          reportHandlers(
            handler(getOrElseDefault(steps, sourceCode), EVERY_FAILURE),
            `Effect.${OPTION}`,
          );
        }
        const isPromiseCatch =
          !isEffectOperation &&
          node.callee.type === "MemberExpression" &&
          memberName(node.callee) === CATCH &&
          node.arguments.length === 1;
        if (isPromiseCatch) {
          reportHandlers(handler(node.arguments[0], "every rejection"), CATCH);
        }
      },
      CatchClause(node) {
        if (!ignoresTheFailure(node.param === null ? [] : [node.param], sourceCode)) {
          return;
        }
        for (const fixed of fixedBranchesOf(returnedValuesIn(node.body), sourceCode)) {
          reportFixed(fixed, { operation: CATCH, failure: "every thrown error" });
        }
      },
      "Program:exit"(node) {
        const isGrantUnused = isGranted && fixedFallbacks.size === 0;
        if (isGrantUnused) {
          context.report({ node, messageId: "unusedGrant" });
        }
      },
    };
  },
});
