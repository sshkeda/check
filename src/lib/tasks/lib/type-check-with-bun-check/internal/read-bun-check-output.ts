import type { PrintableError } from "@sshkeda/task/errors";

import { FORMAT_CONFIG_FILE } from "../../../../../shared/config-file-names.ts";
import {
  printableError,
  printableErrorWith,
} from "../../../../../shared/format-reported-failures.ts";
import { linesOf } from "../../../shared/run-tools-and-decode-their-reports.ts";
import { TypeCheckLineUnrecognized } from "./type-check-errors.ts";

const LOCATED_TYPE_CHECK_VIOLATION =
  /^(?<file>.+)\((?<line>\d+),(?<column>\d+)\): error (?<code>TS\d+): (?<message>.*)$/u;
const UNLOCATED_TYPE_CHECK_VIOLATION = /^error (?<code>TS\d+): (?<message>.*)$/u;
const CONTINUATION = /^\s+\S/u;

const readLine = (
  read: { readonly violations: PrintableError[]; readonly continues: boolean },
  line: string,
) => {
  const [, file, lineNumber, columnNumber, locatedCode, locatedMessage] =
    LOCATED_TYPE_CHECK_VIOLATION.exec(line) ?? [];
  const [, unlocatedCode, unlocatedMessage] = UNLOCATED_TYPE_CHECK_VIOLATION.exec(line) ?? [];
  const previous = read.violations.at(-1);
  const isLocatedViolation =
    file !== undefined &&
    lineNumber !== undefined &&
    columnNumber !== undefined &&
    locatedCode !== undefined &&
    locatedMessage !== undefined;
  if (isLocatedViolation) {
    read.violations.push({
      tag: locatedCode,
      location: `${file}:${lineNumber}:${columnNumber}`,
      message: locatedMessage,
    });
    return { violations: read.violations, continues: true };
  }
  const isUnlocatedViolation = unlocatedCode !== undefined && unlocatedMessage !== undefined;
  if (isUnlocatedViolation) {
    read.violations.push({ tag: unlocatedCode, message: unlocatedMessage });
    return { violations: read.violations, continues: true };
  }
  const continuesPreviousViolation =
    read.continues && previous !== undefined && CONTINUATION.test(line);
  if (continuesPreviousViolation) {
    read.violations.splice(
      -1,
      1,
      printableErrorWith(previous, { message: `${previous.message}\n${line.trim()}` }),
    );
    return { violations: read.violations, continues: true };
  }
  read.violations.push(printableError(new TypeCheckLineUnrecognized({ line })));
  return { violations: read.violations, continues: false };
};

const isInTheFormatConfig = (violation: PrintableError) =>
  violation.location?.startsWith(`${FORMAT_CONFIG_FILE}:`) === true;

export const typeCheckReport = (standardOutput: string, isFormatConfigRefused: boolean) => {
  const read = { violations: new Array<PrintableError>(), continues: false };
  for (const line of linesOf(standardOutput)) {
    read.continues = readLine(read, line).continues;
  }
  const isReportedByTheFormatCheck = (violation: PrintableError) =>
    isFormatConfigRefused && isInTheFormatConfig(violation);
  return {
    violations: read.violations.filter((violation) => !isReportedByTheFormatCheck(violation)),
    reportsOnlyWhatTheFormatCheckReports:
      read.violations.length > 0 && read.violations.every(isReportedByTheFormatCheck),
    notes: [],
  };
};
