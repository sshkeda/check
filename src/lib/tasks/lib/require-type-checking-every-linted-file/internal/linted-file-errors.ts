import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";
import { joinedWithAnd } from "../../../shared/classify-files-by-role.ts";

const compilingConfigFiles = (configFiles: readonly string[]) =>
  `${joinedWithAnd(configFiles)} ${configFiles.length === 1 ? "compiles" : "compile"}`;

export class LintedFileOutsideTypeScriptProgram extends Schema.TaggedError<LintedFileOutsideTypeScriptProgram>()(
  "LintedFileOutsideTypeScriptProgram",
  { location: Schema.String, projectFile: Schema.String },
) {
  public override get message() {
    return `must be type-checked, but no program of ${this.projectFile} compiles it`;
  }
}

export class LintedJavaScriptFileNotTypeChecked extends Schema.TaggedError<LintedJavaScriptFileNotTypeChecked>()(
  "LintedJavaScriptFileNotTypeChecked",
  { location: Schema.String, configFiles: Schema.Array(Schema.String) },
) {
  public override get message() {
    return `must be type-checked, but ${compilingConfigFiles(this.configFiles)} it without checking JavaScript`;
  }
}

export class LintedDeclarationFileNotTypeChecked extends Schema.TaggedError<LintedDeclarationFileNotTypeChecked>()(
  "LintedDeclarationFileNotTypeChecked",
  { location: Schema.String, configFiles: Schema.Array(Schema.String) },
) {
  public override get message() {
    return `must be type-checked, but ${compilingConfigFiles(this.configFiles)} it without checking declaration files`;
  }
}

export class LintedFilesNotTypeChecked extends Schema.TaggedError<LintedFilesNotTypeChecked>()(
  "LintedFilesNotTypeChecked",
  {
    violations: Schema.Array(
      Schema.Union([
        LintedFileOutsideTypeScriptProgram,
        LintedJavaScriptFileNotTypeChecked,
        LintedDeclarationFileNotTypeChecked,
      ]),
    ),
  },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
