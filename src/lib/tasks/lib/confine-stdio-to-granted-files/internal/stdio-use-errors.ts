import { Schema } from "effect";

import {
  READS_CONFIG,
  unusedGrantMessage,
  WRITES_TO_THE_TERMINAL,
} from "../../../../../shared/bans-each-permission-lifts.ts";
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

export const STDIO_PERMISSION = Schema.Literals([READS_CONFIG, WRITES_TO_THE_TERMINAL]);

export class GrantNothingUses extends Schema.TaggedError<GrantNothingUses>()("GrantNothingUses", {
  location: Schema.String,
  permission: STDIO_PERMISSION,
}) {
  public override get message() {
    return unusedGrantMessage(this.permission);
  }
}

export class StdioUsesRefused extends Schema.TaggedError<StdioUsesRefused>()("StdioUsesRefused", {
  violations: Schema.Array(
    Schema.Union([
      StdioArgumentsReadWithoutGrant,
      StdioTerminalWriteWithoutGrant,
      GrantNothingUses,
    ]),
  ),
}) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
