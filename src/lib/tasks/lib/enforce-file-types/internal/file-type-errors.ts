import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class FileTypeNotGranted extends Schema.TaggedError<FileTypeNotGranted>()(
  "FileTypeNotGranted",
  { location: Schema.String, fileType: Schema.String },
) {
  public override get message() {
    return `has file type ${this.fileType}, which is not allowed by default`;
  }
}

export class FileTypeViolations extends Schema.TaggedError<FileTypeViolations>()(
  "FileTypeViolations",
  { violations: Schema.Array(FileTypeNotGranted) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
