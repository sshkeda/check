import { Effect, Schema } from "effect";

import { LINT_CONFIG_FILE } from "./config-file-names.ts";
import { listedViolations } from "./format-reported-failures.ts";

export class MalformedGrant extends Schema.TaggedError<MalformedGrant>()("MalformedGrant", {
  issuePath: Schema.String,
  issueMessage: Schema.String,
  location: Schema.Literal(LINT_CONFIG_FILE).pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(LINT_CONFIG_FILE)),
  ),
}) {
  public override get message() {
    return `${this.issuePath}: ${this.issueMessage}`;
  }
}

export const cannotImportPermission = (target: string) => `cannotImport: ["${target}"]`;

export class RedundantGrant extends Schema.TaggedError<RedundantGrant>()("RedundantGrant", {
  path: Schema.String,
  permission: Schema.String,
  reason: Schema.String,
  location: Schema.Literal(LINT_CONFIG_FILE).pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(LINT_CONFIG_FILE)),
  ),
}) {
  public override get message() {
    return `${this.path} is granted ${this.permission}, but ${this.reason}`;
  }
}

export class PermissionGrantsRefused extends Schema.TaggedError<PermissionGrantsRefused>()(
  "PermissionGrantsRefused",
  { violations: Schema.Array(MalformedGrant) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
