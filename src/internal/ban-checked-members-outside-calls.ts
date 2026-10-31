import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { OPERATIONS_THAT_HANDLE_UNNAMED_FAILURES } from "../shared/bans-each-permission-lifts.ts";
import { NUMBER_PARSERS } from "./ban-parsing-outside-data-without-a-schema.ts";
import {
  DATE_TIME_FORMAT,
  TIMED_WAITS,
} from "./ban-reading-the-clock-and-sleeping-outside-effect.ts";
import {
  DEADLINE_OPERATIONS,
  POLLING_OPERATIONS,
} from "./ban-timer-schedules-without-deadlines.ts";
import { SERVICE_FACTORIES } from "./match-effect-service-factories.ts";
import {
  effectModuleOperation,
  isGlobalReference,
  isImportBinding,
  isValueOperandOfTypeScriptOrExport,
  memberName,
} from "./resolve-what-an-expression-imports.ts";

const RECOVERY_PREFIX = "catch";
const ERROR_MAPPING = "mapError";

const COLLECTING_OPERATION = "all";

const isBannedRecovery = (moduleName: "Channel" | "Effect" | "Stream", operation: string) =>
  OPERATIONS_THAT_HANDLE_UNNAMED_FAILURES[moduleName].some(
    (banned: string) => banned === operation,
  );

const isRecoveryCheckedAtItsCall = (
  moduleName: "Channel" | "Effect" | "Stream",
  operation: string,
) =>
  (operation.startsWith(RECOVERY_PREFIX) || operation === ERROR_MAPPING) &&
  !isBannedRecovery(moduleName, operation);

const EFFECT_MEMBERS_CHECKED_AT_THEIR_CALLS: ReadonlyMap<string, (operation: string) => boolean> =
  new Map([
    [
      "Effect",
      (operation: string) =>
        isRecoveryCheckedAtItsCall("Effect", operation) ||
        operation === COLLECTING_OPERATION ||
        POLLING_OPERATIONS.has(operation) ||
        DEADLINE_OPERATIONS.has(operation),
    ],
    ["Stream", (operation: string) => isRecoveryCheckedAtItsCall("Stream", operation)],
    ["Channel", (operation: string) => isRecoveryCheckedAtItsCall("Channel", operation)],
    ["Context", (operation: string) => SERVICE_FACTORIES.has(operation)],
    ["PlatformError", (operation: string) => operation === "systemError"],
  ]);

const GLOBAL_MEMBERS_CHECKED_AT_THEIR_CALLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Atomics", TIMED_WAITS],
  ["Intl", new Set([DATE_TIME_FORMAT])],
  ["Number", NUMBER_PARSERS],
]);

const rootOf = (node: ESTree.Node): ESTree.Node =>
  node.type === "MemberExpression" ? rootOf(node.object) : node;

const effectMemberNamed = (node: ESTree.Node, sourceCode: SourceCode) => {
  if (!isImportBinding(rootOf(node), sourceCode)) {
    return;
  }
  return [...EFFECT_MEMBERS_CHECKED_AT_THEIR_CALLS]
    .map(([moduleName, isCheckedAtItsCall]) => {
      const operation = effectModuleOperation(node, sourceCode, moduleName);
      const isChecked = operation !== undefined && isCheckedAtItsCall(operation);
      return isChecked ? `${moduleName}.${operation}` : undefined;
    })
    .find((member) => member !== undefined);
};

const globalMemberNamed = (node: ESTree.MemberExpression, sourceCode: SourceCode) => {
  const member = memberName(node);
  const objectName = node.object.type === "Identifier" ? node.object.name : undefined;
  const members =
    objectName === undefined ? undefined : GLOBAL_MEMBERS_CHECKED_AT_THEIR_CALLS.get(objectName);
  const isCheckedGlobalMember =
    objectName !== undefined &&
    member !== undefined &&
    members?.has(member) === true &&
    isGlobalReference(node.object, sourceCode, objectName);
  return isCheckedGlobalMember ? `${objectName}.${member}` : undefined;
};

const isCalledWhereNamed = (node: ESTree.Node) => {
  const { parent } = node;
  const isCallOrConstruction =
    parent?.type === "CallExpression" || parent?.type === "NewExpression";
  return isCallOrConstruction && parent.callee === node;
};

const isValueReference = (node: ESTree.Node) => {
  const { parent } = node;
  if (parent === null) {
    return false;
  }
  if (isValueOperandOfTypeScriptOrExport(node, parent)) {
    return true;
  }
  const isMemberProperty =
    parent.type === "MemberExpression" && parent.property === node && !parent.computed;
  const isPropertyKey =
    parent.type === "Property" &&
    parent.key === node &&
    (!parent.shorthand || parent.value !== node);
  return (
    !isMemberProperty &&
    !isPropertyKey &&
    !parent.type.startsWith("Import") &&
    !parent.type.startsWith("Export") &&
    !parent.type.startsWith("TS")
  );
};

export const noUncalledMembers = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Call a member whose ban is checked at its call, such as Stream.catchTag or Effect.retry, where it is named, so no value carries it past the check.",
    },
    messages: {
      uncalled: "{{member}} is used as a value instead of being called where it is named",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const report = (node: ESTree.Node, member: string | undefined) => {
      const isUncalledCheckedMember = member !== undefined && !isCalledWhereNamed(node);
      if (isUncalledCheckedMember) {
        context.report({ node, messageId: "uncalled", data: { member } });
      }
    };
    return {
      Identifier(node) {
        if (isValueReference(node)) {
          report(node, effectMemberNamed(node, sourceCode));
        }
      },
      MemberExpression(node) {
        report(node, effectMemberNamed(node, sourceCode) ?? globalMemberNamed(node, sourceCode));
      },
    };
  },
});
