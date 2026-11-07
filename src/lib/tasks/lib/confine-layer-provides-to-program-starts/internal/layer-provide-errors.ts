import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export const PROVIDED_VALUES = ["a layer", "a context built from a layer"] as const;

export class LayerProvidedOutsideProgramStart extends Schema.TaggedError<LayerProvidedOutsideProgramStart>()(
  "LayerProvidedOutsideProgramStart",
  {
    location: Schema.String,
    module: Schema.String,
    operation: Schema.String,
    provided: Schema.Literals(PROVIDED_VALUES),
  },
) {
  public override get message() {
    return `${this.module}.${this.operation} with ${this.provided} outside the call that starts the program`;
  }
}

export class LayerProvidesOutsideProgramStarts extends Schema.TaggedError<LayerProvidesOutsideProgramStarts>()(
  "LayerProvidesOutsideProgramStarts",
  { violations: Schema.Array(LayerProvidedOutsideProgramStart) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
