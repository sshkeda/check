import { Schema } from "effect";

export const JSON_TEXT = Schema.fromJsonString(Schema.Unknown);

export const encodeJson = (value: Schema.Json) => Schema.encodeEffect(JSON_TEXT)(value);
