import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";
import type { SourceFile } from "typescript/unstable/ast";
import { SymbolFlags } from "typescript/unstable/async";
import type { Checker } from "typescript/unstable/async";

import { RESTRICTED_PROPERTIES } from "../../src/index.ts";
import { bansByKind } from "../../src/internal/match-banned-modules-and-globals.ts";
import { REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT } from "../../src/lib/tasks/shared/project-config-and-tool-errors.ts";
import {
  openTypeScriptProjects,
  typeScriptRequest,
} from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import {
  everyBanOf,
  IMPORT_META,
  PERMISSION_BAN_NAMES,
  PERMISSION_BANS,
} from "../../src/shared/bans-each-permission-lifts.ts";
import { makeProject as makeProjectWith } from "../shared/checked-project.ts";

const makeProject = makeProjectWith.bind(undefined, REQUIRED_VALUES_OF_OPTIONS_OFF_BY_DEFAULT);

const objectTypeOf = (checker: Checker, location: SourceFile, object: string) =>
  Effect.gen(function* () {
    const objectIsType = object === IMPORT_META;
    const symbol = yield* typeScriptRequest("resolve a global", () =>
      checker.resolveName(
        objectIsType ? "ImportMeta" : object,
        objectIsType ? SymbolFlags.Type : SymbolFlags.Value,
        location,
      ),
    );
    if (symbol === undefined) {
      return;
    }
    return objectIsType
      ? yield* typeScriptRequest("read a global type", () =>
          checker.getDeclaredTypeOfSymbol(symbol),
        )
      : yield* typeScriptRequest("read a global type", () => checker.getTypeOfSymbol(symbol));
  });

export const bannedMembersExistOnTheirObjects = Task.make(
  "every banned member names a property its global object really has",
  Effect.gen(function* () {
    const { tsconfigFile } = yield* makeProject({ "main.ts": "export const MAIN = 1;\n" });
    const [rootProject] = yield* openTypeScriptProjects(tsconfigFile);
    const location = rootProject?.sourceFiles[0]?.sourceFile;
    const isMissingSourceFile = rootProject === undefined || location === undefined;
    if (isMissingSourceFile) {
      return yield* Effect.die("the checked project has no source file");
    }
    const checker = rootProject.checker;
    const entries = [
      ...PERMISSION_BAN_NAMES.flatMap((permission) =>
        bansByKind(everyBanOf(PERMISSION_BANS[permission])).globalMembers.flatMap((ban) =>
          ban.memberNames.map((memberName) => ({
            object: ban.globalObject,
            property: memberName,
          })),
        ),
      ),
      ...RESTRICTED_PROPERTIES,
    ];
    const resolvedObjects: string[] = [];
    const missingMembers: string[] = [];
    for (const { object, property } of entries) {
      const objectType = yield* objectTypeOf(checker, location, object);
      if (objectType === undefined) {
        continue;
      }
      resolvedObjects.push(object);
      const member = yield* typeScriptRequest("read a banned member", () =>
        checker.getPropertyOfType(objectType, property),
      );
      if (member === undefined) {
        missingMembers.push(`${object}.${property}`);
      }
    }
    expect(resolvedObjects).toContain("process");
    expect(resolvedObjects).toContain("Bun");
    expect(resolvedObjects).toContain(IMPORT_META);
    expect(missingMembers).toEqual([]);
  }).pipe(Effect.scoped),
);
