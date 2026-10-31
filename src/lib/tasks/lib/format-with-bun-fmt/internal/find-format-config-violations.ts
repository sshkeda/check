import { Effect, Result } from "effect";

import {
  FORMAT_CONFIG,
  parsedConfigFileIn,
} from "../../../shared/parse-config-files-that-import-from-check.ts";
import { FormatConfigRefused } from "../../../shared/project-config-and-tool-errors.ts";

export const checkedFormatConfigIn = (directory: string) =>
  Effect.gen(function* () {
    const parsed = yield* parsedConfigFileIn(directory, FORMAT_CONFIG);
    const violations = Result.isFailure(parsed) ? parsed.failure : parsed.success.violations;
    if (violations.length > 0) {
      return yield* new FormatConfigRefused({ violations });
    }
  });
