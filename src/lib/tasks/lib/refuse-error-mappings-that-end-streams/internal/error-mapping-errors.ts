import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class ErrorMappedToDone extends Schema.TaggedError<ErrorMappedToDone>()(
  "ErrorMappedToDone",
  { location: Schema.String, operation: Schema.String },
) {
  public override get message() {
    return `${this.operation} can map a failure to Cause.Done, which ends a stream as if it completed`;
  }
}

export class ErrorMappingsRefused extends Schema.TaggedError<ErrorMappingsRefused>()(
  "ErrorMappingsRefused",
  { violations: Schema.Array(ErrorMappedToDone) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
