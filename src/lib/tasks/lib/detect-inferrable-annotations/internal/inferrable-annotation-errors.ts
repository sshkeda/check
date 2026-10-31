import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class InferrableTypeAnnotation extends Schema.TaggedError<InferrableTypeAnnotation>()(
  "InferrableTypeAnnotation",
  {
    location: Schema.String,
    fact: Schema.String,
  },
) {
  public override get message() {
    return this.fact;
  }
}

export class InferrableTypeAnnotations extends Schema.TaggedError<InferrableTypeAnnotations>()(
  "InferrableTypeAnnotations",
  { violations: Schema.Array(InferrableTypeAnnotation) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}

export class SourceOverlayNotApplied extends Schema.TaggedError<SourceOverlayNotApplied>()(
  "SourceOverlayNotApplied",
  { fileName: Schema.String },
) {
  public override get message() {
    return `the TypeScript API checked ${this.fileName} without its type annotations removed`;
  }
}
