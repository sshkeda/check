import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class PromiseChained extends Schema.TaggedError<PromiseChained>()("PromiseChained", {
  location: Schema.String,
  method: Schema.String,
}) {
  public override get message() {
    return `${this.method} is called on a Promise`;
  }
}

export class PromiseChainsRefused extends Schema.TaggedError<PromiseChainsRefused>()(
  "PromiseChainsRefused",
  { violations: Schema.Array(PromiseChained) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
