import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { SCHEDULE_MESSAGES } from "../shared/lint-rule-messages-and-patterns.ts";
import { TEST_HOME } from "../shared/test-home-directories.ts";
import { scheduleVisitors } from "./ban-timer-schedules-without-deadlines.ts";
import { effectModuleReference } from "./resolve-what-an-expression-imports.ts";

const TIMEOUT = "timeout";

export const noTestTimeouts = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: `Bound tests in ${TEST_HOME} only with the timeout option of their task and wait on signals or TestClock instead of timers; Effect timeouts and timed schedules put a second clock inside the test. A test file granted pollsWithADeadline may poll an outside system with Schedule.spaced under a deadline.`,
    },
    messages: { ...SCHEDULE_MESSAGES, timeout: "{{usage}} sets a deadline inside a test" },
  },
  create(context) {
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
    };
  },
});
