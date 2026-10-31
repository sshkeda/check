import type { PrintableError } from "@sshkeda/task/errors";

export const printableError = (failure: {
  readonly _tag: string;
  readonly message: string;
  readonly location?: string;
}): PrintableError => ({
  tag: failure._tag,
  ...(failure.location === undefined ? {} : { location: failure.location }),
  message: failure.message,
});

export const formattedError = (printable: PrintableError) => {
  const [firstLine = "", ...continuationLines] = printable.message.split("\n");
  return [
    `${printable.location === undefined ? "" : `${printable.location}: `}error ${printable.tag}: ${firstLine}`,
    ...continuationLines.map((line) => `  ${line}`),
  ].join("\n");
};

export const listedViolations = (violations: readonly Parameters<typeof printableError>[0][]) =>
  violations.map((found) => formattedError(printableError(found))).join("\n");

export const printableErrorWith = (
  printable: PrintableError,
  replacement: { readonly tag?: string; readonly message?: string },
): PrintableError => ({
  tag: replacement.tag ?? printable.tag,
  ...(printable.location === undefined ? {} : { location: printable.location }),
  message: replacement.message ?? printable.message,
});
