import { Schema } from "effect";

export class UnformattedFile extends Schema.TaggedError<UnformattedFile>()("UnformattedFile", {
  file: Schema.String,
}) {
  public get location() {
    return this.file;
  }
  public override get message() {
    return `is not formatted`;
  }
}
