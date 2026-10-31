import { Schema } from "effect";

const INDENTED_JSON = Schema.fromJsonString(Schema.Unknown, { space: 2 });

export const encodeIndentedJson = (value: Schema.Json) => Schema.encodeEffect(INDENTED_JSON)(value);
