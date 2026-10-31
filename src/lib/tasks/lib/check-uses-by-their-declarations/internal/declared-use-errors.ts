import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class SyncCall extends Schema.TaggedError<SyncCall>()("SyncCall", {
  location: Schema.String,
  api: Schema.String,
}) {
  public override get message() {
    return `${this.api} runs synchronously`;
  }
}

export class SchemaUsedOnlyAsType extends Schema.TaggedError<SchemaUsedOnlyAsType>()(
  "SchemaUsedOnlyAsType",
  { location: Schema.String, schemaName: Schema.String },
) {
  public override get message() {
    return `${this.schemaName} is a schema used only as a type`;
  }
}

export class DeclaredUsesRefused extends Schema.TaggedError<DeclaredUsesRefused>()(
  "DeclaredUsesRefused",
  {
    violations: Schema.Array(Schema.Union([SyncCall, SchemaUsedOnlyAsType])),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
