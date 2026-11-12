import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const joinedWith = (operator: string, testKind: "if" | "ternary" = "if") => ({
  message: `${testKind} condition joins checks with ${operator} without a name`,
});

export const compoundConditionsNeedANamedConst = Task.make({
  name: "no-unnamed-compound-conditions reports an if or ternary condition that joins checks with && or ||, negated, nested or in an else if, and leaves named conditions, single checks, calls, loops and ternary branches alone",
  run: ruleTest("no-unnamed-compound-conditions", {
    valid: [
      "const hasFullLocation = line !== undefined && column !== undefined; if (hasFullLocation) {}",
      "if (ready) {}",
      "if (!ready) {}",
      "if (line !== undefined) {}",
      "if (isReady(first && second)) {}",
      "if (first ?? second) {}",
      "while (first && second) {}",
      "for (; first || second; ) {}",
      "do {} while (first && second);",
      "const bothReady = first && second; const label = bothReady ? 'both' : 'not both';",
      "const label = ready ? 'ready' : 'waiting';",
      "const label = !ready ? 'waiting' : 'ready';",
      "const label = isReady(first && second) ? 'ready' : 'waiting';",
      "const label = first ?? second ? 'set' : 'unset';",
      "const label = ready ? first && second : first || second;",
      "const both = first && second;",
      "if (ready ? first && second : third) {}",
    ],
    invalid: [
      { code: "if (first && second) {}", errors: [joinedWith("&&")] },
      { code: "if (first || second) {}", errors: [joinedWith("||")] },
      { code: "if (first && second && third) {}", errors: [joinedWith("&&")] },
      { code: "if (first && (second || third)) {}", errors: [joinedWith("&&")] },
      { code: "if (!(first || second)) {}", errors: [joinedWith("||")] },
      { code: "if (!!(first && second)) {}", errors: [joinedWith("&&")] },
      { code: "if (ready) {} else if (first || second) {}", errors: [joinedWith("||")] },
      { code: "if ((first && second) ? third : fourth) {}", errors: [joinedWith("&&", "ternary")] },
      {
        code: "const label = first && second ? 'both' : 'not both';",
        errors: [joinedWith("&&", "ternary")],
      },
      {
        code: "const label = first || second ? 'either' : 'neither';",
        errors: [joinedWith("||", "ternary")],
      },
      {
        code: "const label = !(first && second) ? 'not both' : 'both';",
        errors: [joinedWith("&&", "ternary")],
      },
      {
        code: "const label = ready ? 'ready' : first && second ? 'both' : 'not both';",
        errors: [joinedWith("&&", "ternary")],
      },
      {
        code: "const label = (first && second ? third : fourth) ? 'yes' : 'no';",
        errors: [joinedWith("&&", "ternary")],
      },
      {
        code: "const run = () => (first || second ? start() : stop());",
        errors: [joinedWith("||", "ternary")],
      },
      {
        code: "if (first && second) { label = third || fourth ? 'yes' : 'no'; }",
        errors: [joinedWith("&&"), joinedWith("||", "ternary")],
      },
    ],
  }),
});
