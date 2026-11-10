import type { Context, CreateRule, ESTree } from "@oxlint/plugins";

import { SCHEDULE_MESSAGES } from "../shared/lint-rule-messages-and-patterns.ts";
import { scheduleVisitors } from "./ban-timer-schedules-without-deadlines.ts";
import { effectModuleReference } from "./resolve-what-an-expression-imports.ts";

const TIMEOUT = "timeout";

export const noTestTimeouts = {
  meta: {
    type: "problem",
    messages: { ...SCHEDULE_MESSAGES, timeout: "{{usage}} sets a deadline inside a test" },
  },
  create(context: Pick<Context, "report" | "sourceCode">) {
    const schedules = scheduleVisitors({ context, timedSchedules: "banned" });
    const reportEffectTimeout = (node: ESTree.Node) => {
      const usage = effectModuleReference(node, context.sourceCode, "Effect");
      if (usage?.split(".")[1]?.startsWith(TIMEOUT) === true) {
        context.report({ node, messageId: "timeout", data: { usage } });
      }
    };
    return {
      CallExpression(node) {
        schedules.CallExpression(node);
      },
      Identifier(node) {
        schedules.Identifier(node);
        reportEffectTimeout(node);
      },
      MemberExpression(node) {
        schedules.MemberExpression(node);
        reportEffectTimeout(node);
      },
      "Program:exit"() {
        schedules["Program:exit"]();
      },
    };
  },
} satisfies CreateRule;
