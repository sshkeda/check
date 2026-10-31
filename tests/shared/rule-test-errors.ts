import { Schema } from "effect";

export class RuleTestTemplateDataMissing extends Schema.TaggedError<RuleTestTemplateDataMissing>()(
  "RuleTestTemplateDataMissing",
  { rule: Schema.String, messageId: Schema.String, placeholder: Schema.String },
) {
  public override get message() {
    return `the expected ${this.messageId} error of ${this.rule} gives data but no ${this.placeholder}`;
  }
}

export class RuleTestMessageIdUnknown extends Schema.TaggedError<RuleTestMessageIdUnknown>()(
  "RuleTestMessageIdUnknown",
  { rule: Schema.String, messageId: Schema.String },
) {
  public override get message() {
    return `${this.rule} has no message ${this.messageId}`;
  }
}
