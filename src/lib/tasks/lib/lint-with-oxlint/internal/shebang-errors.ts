import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";
import { PACKAGE_MANIFEST_FILE } from "../../../shared/find-named-package-manifests.ts";

export class ShebangOutsideBin extends Schema.TaggedError<ShebangOutsideBin>()(
  "ShebangOutsideBin",
  { location: Schema.String },
) {
  public override get message() {
    return `starts with a shebang line, but ${PACKAGE_MANIFEST_FILE} does not list it under bin`;
  }
}

export class ShebangsOutsideBin extends Schema.TaggedError<ShebangsOutsideBin>()(
  "ShebangsOutsideBin",
  { violations: Schema.Array(ShebangOutsideBin) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
