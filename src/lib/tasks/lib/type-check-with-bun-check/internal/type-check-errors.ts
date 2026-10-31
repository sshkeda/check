import { Schema } from "effect";

export class TypeCheckLineUnrecognized extends Schema.TaggedError<TypeCheckLineUnrecognized>()(
  "TypeCheckLineUnrecognized",
  { line: Schema.String },
) {
  public override get message() {
    return `type-check printed a line that is not a diagnostic or its continuation: ${this.line}`;
  }
}
