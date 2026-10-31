import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const SHEBANG_MESSAGE = "file starts with a shebang line";

export const shebangLinesAreBanned = Task.make(
  "no-shebang reports a shebang at the start of a file, and leaves other hash text alone",
  ruleTest("no-shebang", {
    valid: [
      "const answer = 42;",
      "const path = '#!/usr/bin/env bun';",
      "const source = `\n#!/usr/bin/env bun\n`;",
      "const privateField = class { #value = 1; };",
    ],
    invalid: [
      { code: "#!/usr/bin/env bun\nconst answer = 42;", errors: [{ message: SHEBANG_MESSAGE }] },
      {
        code: "#!/usr/bin/env -S bun --tsconfig-override=tsconfig.json\nconst answer = 42;",
        errors: [{ message: SHEBANG_MESSAGE }],
      },
      { code: "#!/usr/bin/env node", errors: [{ message: SHEBANG_MESSAGE }] },
    ],
  }),
);
