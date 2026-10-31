import {
  equivalentModuleSpecifiers,
  MODULE_PATTERN_WILDCARD,
  moduleOfGlobalObject,
  importsBan,
} from "../shared/bans-each-permission-lifts.ts";
import type { everyBanOf, moduleBan } from "../shared/bans-each-permission-lifts.ts";
import {
  NODE_BUILTIN_RULES,
  nodeBuiltinNameOf,
} from "../shared/lint-rule-messages-and-patterns.ts";

export const bansByKind = (bans: readonly ReturnType<typeof everyBanOf>[number][]) => ({
  module: bans.flatMap((ban) => (ban.kind === "module" ? [ban] : [])),
  imports: bans.flatMap((ban) => (ban.kind === "imports" ? [ban] : [])),
  globalMembers: bans.flatMap((ban) => (ban.kind === "global-members" ? [ban] : [])),
  effectMembers: bans.flatMap((ban) => (ban.kind === "effect-members" ? [ban] : [])),
  memberNames: bans.flatMap((ban) => (ban.kind === "member-names" ? [ban] : [])),
  dynamicImport: bans.flatMap((ban) => (ban.kind === "dynamic-import" ? [ban] : [])),
  createdRequire: bans.flatMap((ban) => (ban.kind === "created-require" ? [ban] : [])),
});

const escapedForRegularExpression = (text: string) =>
  text.replaceAll(/[.+?^${}()|[\]\\/]/gu, String.raw`\$&`);

export const modulePatternMatcher = (modulePattern: string) => {
  const expressions = equivalentModuleSpecifiers(modulePattern).map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split(MODULE_PATTERN_WILDCARD)
          .map((part) => escapedForRegularExpression(part))
          .join(".*")}$`,
        "u",
      ),
  );
  return (specifier: string) => expressions.some((expression) => expression.test(specifier));
};

export const importBansEquivalentToGlobalMembers = (
  bans: readonly ReturnType<typeof everyBanOf>[number][],
) =>
  bansByKind(bans).globalMembers.flatMap((ban) => {
    const module = moduleOfGlobalObject(ban.globalObject);
    return module === undefined ? [] : [importsBan(module, ban.memberNames)];
  });

export const moduleBansMatcher = (moduleBans: readonly ReturnType<typeof moduleBan>[]) => {
  const entries = moduleBans.flatMap((ban) =>
    ban.modulePatterns.map((modulePattern) => ({
      matchesModule: modulePatternMatcher(modulePattern),
      exceptImportNames: ban.exceptImportNames,
    })),
  );
  return (specifier: string, importNames: readonly (string | undefined)[]) =>
    entries.some(
      (entry) =>
        entry.matchesModule(specifier) &&
        !(
          importNames.length > 0 &&
          importNames.every((name) => name !== undefined && entry.exceptImportNames.includes(name))
        ),
    );
};

const MODULES_NODE_BUILTIN_RULES_BAN: ReadonlySet<string> = new Set(
  Object.values(NODE_BUILTIN_RULES).flatMap(({ modules }) => modules),
);

export const isBannedByANodeBuiltinRule = (specifier: string) =>
  MODULES_NODE_BUILTIN_RULES_BAN.has(nodeBuiltinNameOf(specifier));
