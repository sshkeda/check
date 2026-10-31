import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class RepeatedServiceYield extends Schema.TaggedError<RepeatedServiceYield>()(
  "RepeatedServiceYield",
  {
    location: Schema.String,
    service: Schema.String,
    firstYield: Schema.String,
  },
) {
  public override get message() {
    return `service ${this.service} was already yielded at ${this.firstYield}`;
  }
}

export class RepeatedServiceYields extends Schema.TaggedError<RepeatedServiceYields>()(
  "RepeatedServiceYields",
  { violations: Schema.Array(RepeatedServiceYield) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
