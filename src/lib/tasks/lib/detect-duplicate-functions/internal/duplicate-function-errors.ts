import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";
import { joinedWithAnd } from "../../../shared/classify-files-by-role.ts";

export class DuplicateFunction extends Schema.TaggedError<DuplicateFunction>()(
  "DuplicateFunction",
  { location: Schema.String, functionName: Schema.String, copies: Schema.Array(Schema.String) },
) {
  public override get message() {
    const copies = this.copies.length === 1 ? "an exact copy" : "exact copies";
    return `${this.functionName} has ${copies} in ${joinedWithAnd(this.copies)}`;
  }
}

export class DuplicateFunctions extends Schema.TaggedError<DuplicateFunctions>()(
  "DuplicateFunctions",
  { violations: Schema.Array(DuplicateFunction) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
