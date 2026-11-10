import type { Context, CreateRule, ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

import { SCHEDULE_MESSAGES } from "../shared/lint-rule-messages-and-patterns.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import {
  effectModuleReference,
  effectOperation,
  isPipeFunction,
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
const EXPONENTIAL_SCHEDULE = "Schedule.exponential";
const JITTERED_SCHEDULE = "Schedule.jittered";
const SCHEDULES_A_GRANT_ALLOWS = new Set(["Schedule.spaced", EXPONENTIAL_SCHEDULE]);
const PIPE_METHOD = "pipe";
const SCHEDULE_PREFIX = "Schedule.";
const UNTIMED_SCHEDULE_MEMBERS = new Set([
  "concat",
  "concatResult",
  "during",
  "identity",
  "map",
  "max",
  "min",
  "passthrough",
  "recurs",
  "setInputType",
  "tap",
  "upTo",
  "while",
]);

const isUntimed = (usage: string) =>
  usage.startsWith(SCHEDULE_PREFIX) &&
  UNTIMED_SCHEDULE_MEMBERS.has(usage.slice(SCHEDULE_PREFIX.length));

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
  readonly context: Pick<Context, "report" | "sourceCode">;
  readonly timedSchedules: (typeof TIMED_SCHEDULES)[number];
}) => {
  const isDeadlineCall = (node: ESTree.Node) => {
    if (node.type !== "CallExpression") {
      return false;
    }
    const operation = effectOperation(node.callee, context.sourceCode);
    return operation !== undefined && DEADLINE_OPERATIONS.has(operation);
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
      const isTimedSource =
        ancestor.arguments.length >= TWO_ARGUMENTS && ancestor.arguments[0] === child;
      const isDeadlineAroundChild = isDeadlineCall(ancestor) && isTimedSource;
      if (isDeadlineAroundChild) {
        return true;
      }
      const isMethodPipe =
        ancestor.callee.type === "MemberExpression" &&
        !ancestor.callee.computed &&
        ancestor.callee.property.type === "Identifier" &&
        ancestor.callee.property.name === "pipe";
      const isPipeCall = isMethodPipe || isPipeFunction(ancestor.callee, context.sourceCode);
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

  const scheduleUsageOf = (node: ESTree.Node) =>
    effectModuleReference(node, context.sourceCode, "Schedule");

  const isDataLastMapping = (node: ESTree.Node) =>
    node.type === "CallExpression" &&
    scheduleUsageOf(node.callee) === OUTPUT_MAPPING &&
    node.arguments.length === 1;

  const pipeOf = (call: ESTree.CallExpression) => {
    const callee = call.callee;
    if (isPipeFunction(callee, context.sourceCode)) {
      const [source, ...stages] = call.arguments;
      return source === undefined ? undefined : { source, stages };
    }
    const isMethodPipe =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === PIPE_METHOD;
    return isMethodPipe ? { source: callee.object, stages: call.arguments } : undefined;
  };

  const isExponentialSchedule = (node: ESTree.Node | undefined): boolean => {
    if (node?.type !== "CallExpression") {
      return false;
    }
    const usage = scheduleUsageOf(node.callee);
    if (usage === EXPONENTIAL_SCHEDULE) {
      return true;
    }
    if (usage === JITTERED_SCHEDULE) {
      return isExponentialSchedule(node.arguments[0]);
    }
    const piped = pipeOf(node);
    return piped !== undefined && isExponentialSchedule(piped.source);
  };

  const isJitteredExponential = (node: ESTree.Node) => {
    const call = node.parent;
    if (call?.type !== "CallExpression") {
      return false;
    }
    if (call.callee === node) {
      return isExponentialSchedule(call.arguments[0]);
    }
    const piped = pipeOf(call);
    return (
      piped !== undefined &&
      piped.stages.some((stage) => stage === node) &&
      isExponentialSchedule(piped.source)
    );
  };

  const report = (node: ESTree.Node, usage: string, polling: ESTree.Node | null) => {
    if (timedSchedules === "banned") {
      const operation = polling === null ? undefined : pollingOperation(polling);
      const retries = operation !== undefined && RETRY_OPERATIONS.has(operation);
      context.report({ node, messageId: retries ? "retrying" : "polling", data: { usage } });
      return;
    }
    const scheduleAllowedByGrant =
      SCHEDULES_A_GRANT_ALLOWS.has(usage) ||
      (usage === JITTERED_SCHEDULE && isJitteredExponential(node));
    if (!scheduleAllowedByGrant) {
      context.report({ node, messageId: "scheduleEvenWhenGranted", data: { usage } });
      return;
    }
    const lacksDeadline = polling === null || !hasDeadline(polling);
    if (lacksDeadline) {
      context.report({ node, messageId: "deadline", data: { usage } });
    }
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

  const isScheduleCall = (node: ESTree.Node) =>
    node.type === "CallExpression" && scheduleUsageOf(node.callee) !== undefined;

  const composingSchedule = (node: ESTree.Node): ESTree.Node | undefined => {
    const parent = node.parent;
    if (parent?.type === "ArrayExpression") {
      const call = parent.parent;
      const isScheduleList = call.type === "CallExpression" && isScheduleCall(call);
      return isScheduleList ? call : undefined;
    }
    if (parent?.type === "MemberExpression") {
      const call = parent.parent;
      const isPipedSource =
        parent.object === node &&
        call.type === "CallExpression" &&
        call.callee === parent &&
        pipeOf(call) !== undefined;
      return isPipedSource ? call : undefined;
    }
    if (parent?.type !== "CallExpression") {
      return undefined;
    }
    if (parent.callee === node) {
      return parent;
    }
    const isComposedArgument = isScheduleCall(parent) || pipeOf(parent) !== undefined;
    return isComposedArgument ? parent : undefined;
  };

  const outermostSchedule = (node: ESTree.Node): ESTree.Node => {
    const composing = composingSchedule(node);
    return composing === undefined ? node : outermostSchedule(composing);
  };

  const usagesBySchedule = new Map<ESTree.Node, { node: ESTree.Node; usage: string }[]>();

  const scheduleReference = (node: ESTree.Node) => {
    const usage = scheduleUsageOf(node);
    const isUnboundedScheduleUsage = usage !== undefined && !keepsCountOnly(node);
    if (isUnboundedScheduleUsage) {
      const schedule = outermostSchedule(node);
      usagesBySchedule.set(schedule, [...(usagesBySchedule.get(schedule) ?? []), { node, usage }]);
    }
  };

  return {
    Identifier: scheduleReference,
    MemberExpression: scheduleReference,
    "Program:exit"() {
      for (const usages of usagesBySchedule.values()) {
        const timed = usages.filter(({ usage }) => !isUntimed(usage));
        for (const { node, usage } of timed.length > 0 ? timed : usages.slice(0, 1)) {
          report(node, usage, enclosingPolling(node));
        }
      }
    },
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

export const noSchedules = {
  meta: {
    type: "problem",
    messages: SCHEDULE_MESSAGES,
    schema: ruleOptionsJsonSchema(SCHEDULE_OPTIONS),
  },
  create(context: Pick<Context, "options" | "report" | "sourceCode">) {
    return scheduleVisitors({
      context,
      timedSchedules:
        decodeRuleOptions(SCHEDULE_OPTIONS, context.options)?.timedSchedules ?? "banned",
    });
  },
} satisfies CreateRule;
