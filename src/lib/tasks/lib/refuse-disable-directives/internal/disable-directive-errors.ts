import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";
import { SourceFileUnparsable } from "../../../shared/project-config-and-tool-errors.ts";

export class SourceFileUnreadable extends Schema.TaggedError<SourceFileUnreadable>()(
  "SourceFileUnreadable",
  {
    file: Schema.String,
    reason: Schema.String,
  },
) {
  public get location() {
    return this.file;
  }
  public override get message() {
    return `could not be read: ${this.reason}`;
  }
}

export class DisableDirective extends Schema.TaggedError<DisableDirective>()("DisableDirective", {
  file: Schema.String,
  line: Schema.Int,
  directive: Schema.String,
}) {
  public get location() {
    return `${this.file}:${this.line}`;
  }
  public override get message() {
    return `has disable directive ${this.directive}`;
  }
}

export class DirectiveScanViolations extends Schema.TaggedError<DirectiveScanViolations>()(
  "DirectiveScanViolations",
  {
    violations: Schema.Array(
      Schema.Union([DisableDirective, SourceFileUnparsable, SourceFileUnreadable]),
    ),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
