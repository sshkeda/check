import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class IndexReExportRefused extends Schema.TaggedError<IndexReExportRefused>()(
  "IndexReExportRefused",
  { location: Schema.String, judgment: Schema.String },
) {
  public override get message() {
    return this.judgment;
  }
}

export class IndexReExportsRefused extends Schema.TaggedError<IndexReExportsRefused>()(
  "IndexReExportsRefused",
  { violations: Schema.Array(IndexReExportRefused) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
