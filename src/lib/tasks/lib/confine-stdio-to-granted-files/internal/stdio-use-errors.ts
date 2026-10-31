import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class StdioArgumentsReadWithoutGrant extends Schema.TaggedError<StdioArgumentsReadWithoutGrant>()(
  "StdioArgumentsReadWithoutGrant",
  { location: Schema.String },
) {
  public override get message() {
    return "Stdio.args reads configuration";
  }
}

export class StdioTerminalWriteWithoutGrant extends Schema.TaggedError<StdioTerminalWriteWithoutGrant>()(
  "StdioTerminalWriteWithoutGrant",
  { location: Schema.String, member: Schema.Literals(["stdout", "stderr"]) },
) {
  public override get message() {
    return `Stdio.${this.member} writes to the terminal`;
  }
}

export class StdioUsesRefused extends Schema.TaggedError<StdioUsesRefused>()("StdioUsesRefused", {
  violations: Schema.Array(
    Schema.Union([StdioArgumentsReadWithoutGrant, StdioTerminalWriteWithoutGrant]),
  ),
}) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
