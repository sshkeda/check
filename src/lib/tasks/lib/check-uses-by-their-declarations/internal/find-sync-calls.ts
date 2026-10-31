import type { Effect } from "effect";
import type { SourceFile } from "typescript/unstable/ast";

import { isDeclaredSync } from "../../../../../shared/bans-each-permission-lifts.ts";
import { nodePosition } from "../../../shared/query-the-typescript-project.ts";
import type { packageCalleesIn } from "../../../shared/query-the-typescript-project.ts";
import { SyncCall } from "./declared-use-errors.ts";

export const findSyncCalls = (
  sourceFile: SourceFile,
  displayName: string,
  callees: Effect.Success<ReturnType<typeof packageCalleesIn>>,
) =>
  callees.flatMap(({ call, name, className }) =>
    isDeclaredSync(name)
      ? [
          new SyncCall({
            location: `${displayName}:${nodePosition(sourceFile, call).line}`,
            api: className === undefined ? name : `${className}.${name}`,
          }),
        ]
      : [],
  );
