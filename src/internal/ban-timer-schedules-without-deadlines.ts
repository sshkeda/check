import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

import { SCHEDULE_MESSAGES } from "../shared/lint-rule-messages-and-patterns.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import {
  effectModuleReference,
  effectOperation,
  importedExpression,
} from "./resolve-what-an-expression-imports.ts";

const TWO_ARGUMENTS = 2;

export const POLLING_OPERATIONS = new Set([
  "retry",
  "repeat",
  "retryOrElse",
  "repeatOrElse",
  "schedule",
  "scheduleFrom",
]);
const RETRY_OPERATIONS = new Set(["retry", "retryOrElse"]);
const FALLBACK_OPERATIONS = new Set(["retryOrElse", "repeatOrElse"]);
export const DEADLINE_OPERATIONS = new Set(["timeout", "timeoutOption", "timeoutOrElse"]);
const COUNT_ONLY_SCHEDULE = "Schedule.recurs";
const OUTPUT_MAPPING = "Schedule.map";
const SCHEDULE_A_GRANT_ALLOWS = "Schedule.spaced";
const PIPE_METHOD = "pipe";

const isFunctionExpression = (node: ESTree.Node) =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";

const TIMED_SCHEDULES = ["banned", "allowedWithDeadline"] as const;

const SCHEDULE_OPTIONS = Schema.Struct({
  timedSchedules: Schema.optionalKey(Schema.Literals(TIMED_SCHEDULES)),
});

export const scheduleVisitors = ({
  context,
  timedSchedules,
}: {
  readonly context: Context;
  readonly timedSchedules: (typeof TIMED_SCHEDULES)[number];
}) => {
  const isDeadlineCall = (node: ESTree.Node) => {
    if (node.type !== "CallExpression") {
      return false;
    }
    const operation = effectOperation(node.callee, context.sourceCode);
    return operation !== undefined && DEADLINE_OPERATIONS.has(operation);
  };

  const isPipeFunction = (node: ESTree.Node) => {
    const imported = importedExpression(node, context.sourceCode);
    return (
      imported !== undefined &&
      ((imported.module === "effect" && imported.members.join(".") === "pipe") ||
        (imported.module === "effect/Function" && imported.members.join(".") === "pipe"))
    );
  };

  const pollingOperation = (node: ESTree.Node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const operation = effectOperation(node.callee, context.sourceCode);
    const isPollingOperation = operation !== undefined && POLLING_OPERATIONS.has(operation);
    return isPollingOperation ? operation : undefined;
  };

  const hasDeadline = (child: ESTree.Node): boolean => {
    const ancestor = child.parent;
    if (ancestor === null) {
      return false;
    }
    if (ancestor.type === "CallExpression") {
      const isDeadlineAroundChild =
        isDeadlineCall(ancestor) && ancestor.arguments.some((argument) => argument === child);
      if (isDeadlineAroundChild) {
        return true;
      }
      const isMethodPipe =
        ancestor.callee.type === "MemberExpression" &&
        !ancestor.callee.computed &&
        ancestor.callee.property.type === "Identifier" &&
        ancestor.callee.property.name === "pipe";
      const isPipeCall = isMethodPipe || isPipeFunction(ancestor.callee);
      if (isPipeCall) {
        const pipedArguments: readonly ESTree.Node[] = ancestor.arguments;
        const position = pipedArguments.indexOf(child);
        if (ancestor.arguments.slice(position + 1).some((argument) => isDeadlineCall(argument))) {
          return true;
        }
      }
    }
    return hasDeadline(ancestor);
  };

  const enclosingPolling = (node: ESTree.Node): ESTree.Node | null => {
    const ancestor = node.parent;
    if (ancestor === null) {
      return null;
    }
    if (pollingOperation(ancestor) !== undefined) {
      return ancestor;
    }
    return enclosingPolling(ancestor);
  };

  const report = (node: ESTree.Node, usage: string, polling: ESTree.Node | null) => {
    const operation = polling === null ? undefined : pollingOperation(polling);
    const retries = operation !== undefined && RETRY_OPERATIONS.has(operation);
    if (timedSchedules === "banned") {
      context.report({ node, messageId: retries ? "retrying" : "polling", data: { usage } });
      return;
    }
    if (retries) {
      context.report({ node, messageId: "retryingEvenWhenGranted", data: { usage } });
      return;
    }
    if (usage !== SCHEDULE_A_GRANT_ALLOWS) {
      context.report({ node, messageId: "scheduleEvenWhenGranted", data: { usage } });
      return;
    }
    const lacksDeadline = polling === null || !hasDeadline(polling);
    if (lacksDeadline) {
      context.report({ node, messageId: "deadline", data: { usage } });
    }
  };

  const scheduleUsageOf = (node: ESTree.Node) =>
    effectModuleReference(node, context.sourceCode, "Schedule");

  const isDataLastMapping = (node: ESTree.Node) =>
    node.type === "CallExpression" &&
    scheduleUsageOf(node.callee) === OUTPUT_MAPPING &&
    node.arguments.length === 1;

  const pipeOf = (call: ESTree.CallExpression) => {
    const callee = call.callee;
    const isMethodPipe =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === PIPE_METHOD;
    if (isMethodPipe) {
      return { source: callee.object, stages: call.arguments };
    }
    const [source, ...stages] = call.arguments;
    const isPipeFunctionCallWithSource = source !== undefined && isPipeFunction(call.callee);
    return isPipeFunctionCallWithSource ? { source, stages } : undefined;
  };

  const isCountOnlySchedule = (node: ESTree.Node | undefined): boolean => {
    if (node?.type !== "CallExpression") {
      return false;
    }
    const usage = scheduleUsageOf(node.callee);
    if (usage === COUNT_ONLY_SCHEDULE) {
      return node.arguments.length === 1;
    }
    if (usage === OUTPUT_MAPPING) {
      return node.arguments.length === TWO_ARGUMENTS && isCountOnlySchedule(node.arguments[0]);
    }
    const piped = pipeOf(node);
    return (
      piped !== undefined &&
      isCountOnlySchedule(piped.source) &&
      piped.stages.every((stage) => isDataLastMapping(stage))
    );
  };

  const keepsCountOnly = (node: ESTree.Node) => {
    const call = node.parent;
    if (call?.type !== "CallExpression") {
      return false;
    }
    if (call.callee !== node) {
      return false;
    }
    if (isCountOnlySchedule(call)) {
      return true;
    }
    const piped = call.parent.type === "CallExpression" ? pipeOf(call.parent) : undefined;
    const stage = piped?.stages.indexOf(call) ?? -1;
    return (
      piped !== undefined &&
      stage !== -1 &&
      isDataLastMapping(call) &&
      isCountOnlySchedule(piped.source) &&
      piped.stages.slice(0, stage).every((earlier) => isDataLastMapping(earlier))
    );
  };

  const scheduleReference = (node: ESTree.Node) => {
    const usage = scheduleUsageOf(node);
    const isUnboundedScheduleUsage = usage !== undefined && !keepsCountOnly(node);
    if (isUnboundedScheduleUsage) {
      report(node, usage, enclosingPolling(node));
    }
  };

  return {
    Identifier: scheduleReference,
    MemberExpression: scheduleReference,
    CallExpression(node: ESTree.CallExpression) {
      const operation = pollingOperation(node);
      if (operation === undefined) {
        return;
      }
      const policies = FALLBACK_OPERATIONS.has(operation)
        ? node.arguments.slice(0, -1)
        : node.arguments;
      if (policies.some((policy) => isFunctionExpression(policy))) {
        report(node.callee, `Effect.${operation} with a schedule`, node);
      }
    },
  };
};

export const noSchedules = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Wait on signals instead of timers; Schedule.recurs(n) counts without a timer, and files allowed pollsWithADeadline may repeat with Schedule.spaced when the polling has a deadline, but no file retries on a timer.",
    },
    messages: SCHEDULE_MESSAGES,
    schema: ruleOptionsJsonSchema(SCHEDULE_OPTIONS),
  },
  create(context) {
    return scheduleVisitors({
      context,
      timedSchedules:
        decodeRuleOptions(SCHEDULE_OPTIONS, context.options)?.timedSchedules ?? "banned",
    });
  },
});
