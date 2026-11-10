import type { Context, CreateRule, Visitor } from "@oxlint/plugins";
import { Schema } from "effect";

import {
  HANDLES_EVERY_FAILURE,
  PERMISSION_BANS,
  RULES_EACH_PERMISSION_LIFTS,
  SHORT_NAMES,
  TRUSTS_UNVERIFIED_TYPES,
  unusedGrantMessage,
} from "../shared/bans-each-permission-lifts.ts";
import {
  CLOCK_RULE,
  CODE_GRANTS,
  FAILURES_AS_RESULTS_RULE,
  INSIDE_THE_TEST_HOME,
  rulesACodeGrantChanges,
  SCHEDULES_RULE,
  SLEEP_RULE,
  TEST_TIMEOUTS_RULE,
  TYPE_PREDICATES_RULE,
  UNNAMED_FALLBACKS_RULE,
} from "../shared/record-and-grant-permissions-by-path.ts";
import { noAbbreviations } from "./ban-abbreviated-words-in-declared-names.ts";
import { noTestTimeouts } from "./ban-deadlines-inside-tests.ts";
import { effectOperationRule } from "./ban-dropped-failures-detached-fibers-sleeps-and-untraced-functions.ts";
import { noFailuresAsResults } from "./ban-failures-collected-as-results.ts";
import { noUnnamedFallbacks } from "./ban-fallbacks-of-named-recoveries.ts";
import { noClockReadsAndSleeps } from "./ban-reading-the-clock-and-sleeping-outside-effect.ts";
import { noSchedules } from "./ban-timer-schedules-without-deadlines.ts";
import { noTypePredicates } from "./ban-type-predicates.ts";
import { mergedVisitors, permissionBanRule } from "./ban-what-a-file-is-not-granted.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";

const RULES_CODE_GRANTS_CHANGE: ReadonlyMap<
  string,
  {
    readonly create: (context: Pick<Context, "options" | "report" | "sourceCode">) => Visitor;
  }
> = new Map(
  Object.entries({
    [PERMISSION_BANS[HANDLES_EVERY_FAILURE].ruleName]: permissionBanRule(HANDLES_EVERY_FAILURE),
    [PERMISSION_BANS[TRUSTS_UNVERIFIED_TYPES].ruleName]: permissionBanRule(TRUSTS_UNVERIFIED_TYPES),
    [FAILURES_AS_RESULTS_RULE]: noFailuresAsResults,
    [UNNAMED_FALLBACKS_RULE]: noUnnamedFallbacks,
    [SLEEP_RULE]: effectOperationRule(SLEEP_RULE),
    [CLOCK_RULE]: noClockReadsAndSleeps,
    [SCHEDULES_RULE]: noSchedules,
    [TEST_TIMEOUTS_RULE]: noTestTimeouts,
    [RULES_EACH_PERMISSION_LIFTS[SHORT_NAMES]]: noAbbreviations,
    [TYPE_PREDICATES_RULE]: noTypePredicates,
  }).map(([name, rule]) => [`sshkeda/${name}`, rule] as const),
);

const UNUSED_CODE_GRANT_OPTIONS = Schema.Struct({
  permissions: Schema.optionalKey(Schema.Array(Schema.Literals(CODE_GRANTS))),
  testHome: Schema.optionalKey(Schema.Literal(INSIDE_THE_TEST_HOME)),
});

export const noUnusedCodeGrants = {
  meta: {
    type: "problem",
    messages: { unusedGrant: unusedGrantMessage("{{permission}}") },
    schema: ruleOptionsJsonSchema(UNUSED_CODE_GRANT_OPTIONS),
  },
  create(context) {
    const { sourceCode } = context;
    const options = decodeRuleOptions(UNUSED_CODE_GRANT_OPTIONS, context.options);
    const isInTheTestHome = options?.testHome === INSIDE_THE_TEST_HOME;
    const runUnder = (ruleId: string, ruleOptions: Context["options"]) => {
      const rule = RULES_CODE_GRANTS_CHANGE.get(ruleId);
      if (rule === undefined) {
        return [];
      }
      const reported = new Set<unknown>();
      const visitor = rule.create({
        sourceCode,
        options: ruleOptions,
        report: (diagnostic) => {
          reported.add(diagnostic.node ?? diagnostic);
        },
      });
      return [{ visitor, reported }];
    };
    const watched = (options?.permissions ?? []).map((permission) => {
      const changed = rulesACodeGrantChanges(permission, isInTheTestHome);
      return {
        permission,
        withoutTheGrant: changed
          .filter(({ isOnWithoutTheGrant }) => isOnWithoutTheGrant)
          .flatMap(({ ruleId }) => runUnder(ruleId, [])),
        withTheGrant: changed.flatMap(({ ruleId, granted }) =>
          granted === "off" ? [] : runUnder(ruleId, [granted[1]]),
        ),
      };
    });
    const isUsed = ({ withoutTheGrant, withTheGrant }: (typeof watched)[number]) => {
      const stillReported = new Set(withTheGrant.flatMap(({ reported }) => [...reported]));
      return withoutTheGrant.some(({ reported }) =>
        [...reported].some((node) => !stillReported.has(node)),
      );
    };
    return mergedVisitors([
      ...watched.flatMap(({ withoutTheGrant, withTheGrant }) =>
        [...withoutTheGrant, ...withTheGrant].map(({ visitor }) => visitor),
      ),
      {
        "Program:exit"(node) {
          for (const grant of watched) {
            if (!isUsed(grant)) {
              context.report({
                node,
                messageId: "unusedGrant",
                data: { permission: grant.permission },
              });
            }
          }
        },
      },
    ]);
  },
} satisfies CreateRule;
