import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

const joinedWithOr = (names: readonly string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}` : names.join("");

export class ForkFailureUnobserved extends Schema.TaggedError<ForkFailureUnobserved>()(
  "ForkFailureUnobserved",
  {
    location: Schema.String,
    fork: Schema.String,
    failures: Schema.Array(Schema.String),
  },
) {
  public override get message() {
    return `${this.fork} forks an effect that can still fail with ${joinedWithOr(this.failures)}, and its fiber is dropped where it is made.`;
  }
}

export class UnobservedForkFailuresRefused extends Schema.TaggedError<UnobservedForkFailuresRefused>()(
  "UnobservedForkFailuresRefused",
  { violations: Schema.Array(ForkFailureUnobserved) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
