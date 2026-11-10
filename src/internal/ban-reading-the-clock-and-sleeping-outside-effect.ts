import type { Context, CreateRule, ESTree, SourceCode } from "@oxlint/plugins";
import { Schema } from "effect";

import { moduleSpecifiersOfGlobalObject } from "../shared/bans-each-permission-lifts.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import {
  effectModuleReference,
  effectOperation,
  importedExpression,
  isGlobalReference,
  memberName,
  propertyKeyName,
  resolvedVariable,
} from "./resolve-what-an-expression-imports.ts";

export const CLOCK_PROPERTIES = [
  { object: "process", property: "hrtime" },
  { object: "process", property: "uptime" },
  { object: "Bun", property: "nanoseconds" },
  { object: "AbortSignal", property: "timeout" },
  { object: "Bun", property: "sleepSync" },
  { object: "Temporal", property: "Now" },
] as const;

const CLOCK_READS = new Set([
  "DateTime.nowUnsafe",
  "DateTime.isFutureUnsafe",
  "DateTime.isPastUnsafe",
]);
const CRON_STEPS = new Set(["Cron.next", "Cron.prev", "Cron.sequence"]);
const ARGUMENTS_OF_A_CRON_STEP_FROM_A_TIME = 2;
const DATE_FORMATS = new Set(["format", "formatToParts"]);
export const DATE_TIME_FORMAT = "DateTimeFormat";
export const TIMED_WAITS = new Set(["wait", "waitAsync"]);
const ARGUMENTS_OF_A_TIMED_WAIT = 4;
const UNTIMED_WAIT_TIMEOUTS = ["undefined", "Infinity"] as const;
const EFFECT_TIMEOUTS = new Set(["timeout", "timeoutOption", "timeoutOrElse"]);
const PIPE = "pipe";
const OPERATIONS_THAT_KEEP_WAITING = new Set(["onInterrupt", "ensuring", "onExit", "asVoid", "as"]);

const isDateTimeFormatConstruction = (node: ESTree.Node, sourceCode: SourceCode) => {
  const isConstruction = node.type === "NewExpression" || node.type === "CallExpression";
  return (
    isConstruction &&
    node.callee.type === "MemberExpression" &&
    memberName(node.callee) === DATE_TIME_FORMAT &&
    isGlobalReference(node.callee.object, sourceCode, "Intl")
  );
};

const isDateTimeFormatter = (node: ESTree.Node, sourceCode: SourceCode) => {
  const variable = resolvedVariable(node, sourceCode);
  if (variable?.references.some((reference) => reference.isWrite() && !reference.init) === true) {
    return false;
  }
  const declarator = variable?.defs[0]?.node;
  const initializer =
    declarator?.type === "VariableDeclarator" ? (declarator.init ?? undefined) : undefined;
  return isDateTimeFormatConstruction(initializer ?? node, sourceCode);
};

const CLOCK_SERVICE = "Clock.Clock";
const CLOCK_CALLBACK_OPERATIONS = new Set(["Effect.clockWith", "Clock.clockWith"]);
const CLOCK_SLEEP = "sleep";
const CLOCK_SERVICE_SLEEPS = ["banned", "allowed"] as const;

const CLOCK_OPTIONS = Schema.Struct({
  clockServiceSleeps: Schema.optionalKey(Schema.Literals(CLOCK_SERVICE_SLEEPS)),
});

const isYieldedClockService = (node: ESTree.Node | null | undefined, sourceCode: SourceCode) =>
  node?.type === "YieldExpression" &&
  node.delegate &&
  node.argument !== null &&
  effectModuleReference(node.argument, sourceCode, "Clock") === CLOCK_SERVICE;

const isClockCallbackParameter = (parameter: ESTree.Node, sourceCode: SourceCode) => {
  const callback = parameter.parent;
  const call = callback?.parent;
  const isFirstParameterOfACallback =
    (callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression") &&
    callback.params[0] === parameter &&
    call?.type === "CallExpression" &&
    call.arguments[0] === callback;
  if (!isFirstParameterOfACallback) {
    return false;
  }
  const operation =
    effectModuleReference(call.callee, sourceCode, "Effect") ??
    effectModuleReference(call.callee, sourceCode, "Clock");
  return operation !== undefined && CLOCK_CALLBACK_OPERATIONS.has(operation);
};

const isClockService = (node: ESTree.Node, sourceCode: SourceCode) => {
  const isTheClockService =
    isYieldedClockService(node, sourceCode) || isClockCallbackParameter(node, sourceCode);
  if (isTheClockService) {
    return true;
  }
  const variable = resolvedVariable(node, sourceCode);
  if (variable?.references.some((reference) => reference.isWrite() && !reference.init) === true) {
    return false;
  }
  const definition = variable?.defs[0];
  if (definition?.type === "Parameter") {
    return isClockCallbackParameter(definition.name, sourceCode);
  }
  const declarator = definition?.node;
  return (
    declarator?.type === "VariableDeclarator" &&
    declarator.id === definition?.name &&
    isYieldedClockService(declarator.init, sourceCode)
  );
};

const isPipeFunction = (node: ESTree.Node, sourceCode: SourceCode) => {
  const imported = importedExpression(node, sourceCode);
  return imported?.module.startsWith("effect") === true && imported.members.at(-1) === PIPE;
};

export const noClockReadsAndSleeps = {
  meta: {
    type: "problem",
    messages: {
      dateCall: "calling the Date constructor is banned",
      currentDate: "new Date() reads the current time",
      clockRead: "{{usage}} reads the current time outside Effect Clock",
      restrictedProperty: "{{usage}} is banned",
      formatsNow: "{{method}}() of Intl.DateTimeFormat without a date formats the current time",
      timedWait: "Atomics.{{method}} with a timeout sleeps",
      neverTimeout: "{{usage}} on Effect.never sleeps",
    },
    schema: ruleOptionsJsonSchema(CLOCK_OPTIONS),
  },
  create(context: Pick<Context, "options" | "report" | "sourceCode">) {
    const { sourceCode } = context;
    const clockServiceSleeps =
      decodeRuleOptions(CLOCK_OPTIONS, context.options)?.clockServiceSleeps ?? "banned";
    const isGlobalDate = (callee: ESTree.Node) => isGlobalReference(callee, sourceCode, "Date");
    const keepsWaiting = (operation: ESTree.Node) => {
      const operationName = effectOperation(
        operation.type === "CallExpression" ? operation.callee : operation,
        sourceCode,
      );
      return operationName !== undefined && OPERATIONS_THAT_KEEP_WAITING.has(operationName);
    };
    const isNever = (node: ESTree.Node | undefined): boolean => {
      if (node === undefined) {
        return false;
      }
      if (effectOperation(node, sourceCode) === "never") {
        return true;
      }
      if (node.type !== "CallExpression") {
        return false;
      }
      const [first, ...rest] = node.arguments;
      const isPipeMethodOnNever =
        node.callee.type === "MemberExpression" &&
        memberName(node.callee) === PIPE &&
        isNever(node.callee.object) &&
        node.arguments.every((operation) => keepsWaiting(operation));
      const isPipeFunctionFromNever =
        isPipeFunction(node.callee, sourceCode) &&
        isNever(first) &&
        rest.every((operation) => keepsWaiting(operation));
      return isPipeMethodOnNever || isPipeFunctionFromNever;
    };

    const isTimeoutOnNever = (node: ESTree.CallExpression) => {
      if (isNever(node.arguments[0])) {
        return true;
      }
      const { parent } = node;
      if (parent.type !== "CallExpression") {
        return false;
      }
      const { callee } = parent;
      const position = parent.arguments.indexOf(node);
      const operationsBefore = (start: number) =>
        parent.arguments.slice(start, position).every((operation) => keepsWaiting(operation));
      if (callee.type === "MemberExpression") {
        return memberName(callee) === PIPE && isNever(callee.object) && operationsBefore(0);
      }
      return (
        isPipeFunction(callee, sourceCode) &&
        position > 0 &&
        isNever(parent.arguments[0]) &&
        operationsBefore(1)
      );
    };

    const reportRestrictedProperty = (
      node: ESTree.Node,
      receiver: ESTree.Node,
      name: string | undefined,
    ) => {
      const imported = importedExpression(receiver, sourceCode);
      const restricted = CLOCK_PROPERTIES.find(({ object, property }) => {
        const isImportedObject =
          imported?.members.length === 0 &&
          moduleSpecifiersOfGlobalObject(object).includes(imported.module);
        return (
          name === property && (isGlobalReference(receiver, sourceCode, object) || isImportedObject)
        );
      });
      if (restricted !== undefined) {
        context.report({
          node,
          messageId: "restrictedProperty",
          data: { usage: `${restricted.object}.${restricted.property}` },
        });
        return;
      }
      const sleepsThroughTheClockService =
        clockServiceSleeps === "banned" &&
        name === CLOCK_SLEEP &&
        isClockService(receiver, sourceCode);
      if (sleepsThroughTheClockService) {
        context.report({ node, messageId: "restrictedProperty", data: { usage: "Clock.sleep" } });
      }
    };

    const reportClockRead = (node: ESTree.Node) => {
      const usage = effectModuleReference(node, sourceCode, "DateTime");
      const readsTheClock = usage !== undefined && CLOCK_READS.has(usage);
      if (readsTheClock) {
        context.report({ node, messageId: "clockRead", data: { usage } });
      }
      if (node.type === "MemberExpression") {
        reportRestrictedProperty(node, node.object, memberName(node));
      }
    };

    const reportDestructuredProperties = (pattern: ESTree.Node, value: ESTree.Node | null) => {
      const isMissingObjectPattern = pattern.type !== "ObjectPattern" || value === null;
      if (isMissingObjectPattern) {
        return;
      }
      for (const property of pattern.properties) {
        if (property.type === "Property") {
          reportRestrictedProperty(property, value, propertyKeyName(property));
        }
      }
    };

    return {
      CallExpression(node) {
        if (isGlobalDate(node.callee)) {
          context.report({ node, messageId: "dateCall" });
          return;
        }
        const timeout = effectOperation(node.callee, sourceCode);
        const isEffectTimeoutOnNever =
          timeout !== undefined && EFFECT_TIMEOUTS.has(timeout) && isTimeoutOnNever(node);
        if (isEffectTimeoutOnNever) {
          context.report({ node, messageId: "neverTimeout", data: { usage: `Effect.${timeout}` } });
          return;
        }
        const cronStep = effectModuleReference(node.callee, sourceCode, "Cron");
        const startTime = node.arguments[ARGUMENTS_OF_A_CRON_STEP_FROM_A_TIME - 1];
        const hasNoStartTime =
          startTime === undefined || isGlobalReference(startTime, sourceCode, "undefined");
        const stepsFromTheCurrentTime =
          cronStep !== undefined &&
          CRON_STEPS.has(cronStep) &&
          hasNoStartTime &&
          node.arguments.every((argument) => argument.type !== "SpreadElement");
        if (stepsFromTheCurrentTime) {
          context.report({ node, messageId: "clockRead", data: { usage: cronStep } });
          return;
        }
        if (node.callee.type !== "MemberExpression") {
          return;
        }
        const method = memberName(node.callee);
        if (method === undefined) {
          return;
        }
        const formatsTheCurrentDate =
          DATE_FORMATS.has(method) &&
          node.arguments.length === 0 &&
          isDateTimeFormatter(node.callee.object, sourceCode);
        if (formatsTheCurrentDate) {
          context.report({ node, messageId: "formatsNow", data: { method } });
          return;
        }
        const waitTimeout = node.arguments[ARGUMENTS_OF_A_TIMED_WAIT - 1];
        const isUntimedWait =
          waitTimeout !== undefined &&
          UNTIMED_WAIT_TIMEOUTS.some((name) => isGlobalReference(waitTimeout, sourceCode, name));
        const waitsWithATimeout =
          TIMED_WAITS.has(method) &&
          node.arguments.length >= ARGUMENTS_OF_A_TIMED_WAIT &&
          !isUntimedWait &&
          isGlobalReference(node.callee.object, sourceCode, "Atomics");
        if (waitsWithATimeout) {
          context.report({ node, messageId: "timedWait", data: { method } });
        }
      },
      NewExpression(node) {
        const constructsTheCurrentDate = node.arguments.length === 0 && isGlobalDate(node.callee);
        if (constructsTheCurrentDate) {
          context.report({ node, messageId: "currentDate" });
        }
      },
      Identifier: reportClockRead,
      MemberExpression: reportClockRead,
      VariableDeclarator(node) {
        reportDestructuredProperties(node.id, node.init);
      },
      AssignmentExpression(node) {
        reportDestructuredProperties(node.left, node.right);
      },
      ObjectPattern(node) {
        if (isClockCallbackParameter(node, sourceCode)) {
          reportDestructuredProperties(node, node);
        }
      },
    };
  },
} satisfies CreateRule;
