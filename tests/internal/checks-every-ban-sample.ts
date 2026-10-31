import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import {
  bansByKind,
  moduleBansMatcher,
} from "../../src/internal/match-banned-modules-and-globals.ts";
import {
  BANS_NO_GRANT_LIFTS,
  bansNoGrantLifts,
  CREATE_REQUIRE_VALUE_USAGE,
  CREATED_REQUIRE_USAGE,
  equivalentModuleSpecifiers,
  IMPORT_META,
  MODULE_PATTERN_WILDCARD,
  moduleSpecifiersOfGlobalObject,
  PERMISSION_BAN_NAMES,
  PERMISSION_BANS,
} from "../../src/shared/bans-each-permission-lifts.ts";
import type { everyBanOf } from "../../src/shared/bans-each-permission-lifts.ts";
import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const SAMPLE_MODULE_NAME = "sample";

const GRANTED = [{ bans: BANS_NO_GRANT_LIFTS }] as const;

const sampleSpecifiers = (modulePattern: string) =>
  equivalentModuleSpecifiers(modulePattern.replaceAll(MODULE_PATTERN_WILDCARD, SAMPLE_MODULE_NAME));

const effectMemberSample = (memberPath: readonly [string, ...string[]]) =>
  `import { ${memberPath[0]} } from "effect"; ${memberPath.join(".")};`;

const samplesOf = (
  ban: ReturnType<typeof everyBanOf>[number],
  liftedByAGrant: boolean,
  isWholeModuleBannedWithoutAGrant: (specifier: string) => boolean,
) => {
  const options = liftedByAGrant ? [] : GRANTED;
  const violation = (code: string, usage: string) => ({
    code,
    options,
    errors: [{ messageId: liftedByAGrant ? "banned" : "bannedEvenWhenGranted", data: { usage } }],
  });
  const spared = (code: string) => ({ code, options });
  switch (ban.kind) {
    case "module": {
      return {
        banned: ban.modulePatterns
          .flatMap((pattern) => sampleSpecifiers(pattern))
          .map((specifier) => violation(`import moduleValue from "${specifier}";`, specifier)),
        spared: ban.modulePatterns
          .flatMap((pattern) => sampleSpecifiers(pattern))
          .flatMap((specifier) =>
            ban.exceptImportNames.map((importName) =>
              spared(`import { ${importName} } from "${specifier}";`),
            ),
          ),
      };
    }
    case "imports": {
      return {
        banned: sampleSpecifiers(ban.modulePattern).flatMap((specifier) =>
          ban.importNames.flatMap((importName) =>
            [
              `import { ${importName.split(".")[0]} } from "${specifier}"; ${importName};`,
              ...(isWholeModuleBannedWithoutAGrant(specifier)
                ? []
                : [
                    `import * as moduleNamespace from "${specifier}"; const { "${importName.split(".").at(-1)}": alias } = moduleNamespace${importName.includes(".") ? `.${importName.split(".").slice(0, -1).join(".")}` : ""};`,
                  ]),
            ].map((code) => violation(code, `${importName} from ${specifier}`)),
          ),
        ),
        spared: [],
      };
    }
    case "global-members": {
      return {
        banned: ban.memberNames.flatMap((memberName) => [
          violation(`${ban.globalObject}.${memberName};`, `${ban.globalObject}.${memberName}`),
          ...moduleSpecifiersOfGlobalObject(ban.globalObject).map((specifier) =>
            violation(
              `import { ${memberName} } from "${specifier}";`,
              `${memberName} from ${specifier}`,
            ),
          ),
        ]),
        spared:
          ban.globalObject === IMPORT_META
            ? []
            : ban.memberNames.map((memberName) =>
                spared(
                  `const ${ban.globalObject} = { ${memberName}: 1 }; ${ban.globalObject}.${memberName};`,
                ),
              ),
      };
    }
    case "effect-members": {
      return {
        banned: ban.memberPathPrefixes.map((memberPathPrefix) =>
          violation(effectMemberSample(memberPathPrefix), memberPathPrefix.join(".")),
        ),
        spared: ban.exceptExactMemberPaths.map((memberPath) =>
          spared(effectMemberSample(memberPath)),
        ),
      };
    }
    case "member-names": {
      return {
        banned: ban.memberNames.flatMap((memberName) => [
          violation(`receiver.${memberName}();`, memberName),
          violation(`const { ${memberName} } = receiver;`, memberName),
          violation(`const { "${memberName}": alias } = receiver;`, memberName),
        ]),
        spared: [],
      };
    }
    case "dynamic-import": {
      return {
        banned: [violation(`import("${SAMPLE_MODULE_NAME}");`, "dynamic import()")],
        spared: [],
      };
    }
    case "created-require": {
      return {
        banned: sampleSpecifiers(ban.modulePattern).flatMap((specifier) =>
          ban.importNames.flatMap((importName) => {
            const imports = `import { ${importName.split(".")[0]} } from "${specifier}";`;
            return [
              violation(
                `${imports} ${importName}(import.meta.url)("${SAMPLE_MODULE_NAME}");`,
                CREATED_REQUIRE_USAGE,
              ),
              violation(
                `${imports} const load = ${importName}(import.meta.url); load("${SAMPLE_MODULE_NAME}");`,
                CREATED_REQUIRE_USAGE,
              ),
              violation(`${imports} [${importName}];`, CREATE_REQUIRE_VALUE_USAGE),
            ];
          }),
        ),
        spared: sampleSpecifiers(ban.modulePattern).flatMap((specifier) =>
          ban.importNames.flatMap((importName) => {
            const imports = `import { ${importName.split(".")[0]} } from "${specifier}";`;
            return ban.exceptMemberNames.flatMap((memberName) => [
              spared(
                `${imports} ${importName}(import.meta.url).${memberName}("${SAMPLE_MODULE_NAME}");`,
              ),
              spared(
                `${imports} const load = ${importName}(import.meta.url); load.${memberName}("${SAMPLE_MODULE_NAME}");`,
              ),
            ]);
          }),
        ),
      };
    }
  }
};

export const everyBanCatchesItsSamplesOnly = Task.make(
  "every permission ban reports a sample of each entry and spares each exception it lists",
  Effect.forEach(
    PERMISSION_BAN_NAMES,
    (permission) => {
      const isWholeModuleBannedWithoutAGrant = (specifier: string) =>
        moduleBansMatcher(bansByKind(bansNoGrantLifts(permission)).module)(specifier, []);
      const samples = [
        ...PERMISSION_BANS[permission].bans.map((ban) =>
          samplesOf(ban, true, isWholeModuleBannedWithoutAGrant),
        ),
        ...bansNoGrantLifts(permission).map((ban) =>
          samplesOf(ban, false, isWholeModuleBannedWithoutAGrant),
        ),
      ];
      return ruleTest(PERMISSION_BANS[permission].ruleName, {
        valid: samples.flatMap((sample) => sample.spared),
        invalid: samples.flatMap((sample) => sample.banned),
      });
    },
    { discard: true },
  ),
);
