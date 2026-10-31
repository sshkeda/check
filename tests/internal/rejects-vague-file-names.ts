import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const CODE = "export const VALUE = 1;";

const fileNameIn = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const vague = (path: string, name: string) => ({
  code: CODE,
  filename: path,
  errors: [{ messageId: "vague", data: { fileName: fileNameIn(path), name } }],
});

const vagueSuffix = (path: string, suffix: string) => ({
  code: CODE,
  filename: path,
  errors: [{ messageId: "vagueSuffix", data: { fileName: fileNameIn(path), suffix } }],
});

export const rejectsVagueFileNames = Task.make(
  "no-vague-file-names rejects utils, helpers, common, misc, types, logic and impl as names, a .logic or .impl suffix, and index files that are not index.ts or index.tsx entries",
  ruleTest("no-vague-file-names", {
    valid: [
      { code: CODE, filename: "src/lib/encode-json.ts" },
      { code: CODE, filename: "src/lib/error-types.ts" },
      { code: CODE, filename: "src/lib/common-ancestor.ts" },
      { code: CODE, filename: "src/index.ts" },
      { code: CODE, filename: "src/lib/rules/index.ts" },
      { code: CODE, filename: "src/components/index.tsx" },
      { code: CODE, filename: "scripts/ci.ts" },
      { code: CODE, filename: "src/lib/logic-gates.ts" },
      { code: CODE, filename: "src/lib/implement-retries.ts" },
    ],
    invalid: [
      vague("src/lib/utils.ts", "utils"),
      vague("src/lib/helpers.ts", "helpers"),
      vague("src/common.ts", "common"),
      vague("scripts/shared/misc.ts", "misc"),
      vague("src/lib/types.ts", "types"),
      vague("src/lib/types.d.ts", "types"),
      vague("src/orders/logic.ts", "logic"),
      vague("src/orders/impl.tsx", "impl"),
      vagueSuffix("src/orders/pricing.logic.ts", "logic"),
      vagueSuffix("src/orders/store.impl.ts", "impl"),
      vagueSuffix("src/orders/store.impl.tsx", "impl"),
      {
        code: CODE,
        filename: "src/lib/index.js",
        errors: [{ messageId: "index", data: { fileName: "index.js" } }],
      },
    ],
  }),
);
