export const printableError = (failure: {
  readonly _tag: string;
  readonly message: string;
  readonly location?: string;
}) => ({
  tag: failure._tag,
  ...(failure.location === undefined ? {} : { location: failure.location }),
  message: failure.message,
});

export const formattedError = (printable: {
  readonly tag: string;
  readonly location?: string | undefined;
  readonly message: string;
}) => {
  const [firstLine = "", ...continuationLines] = printable.message.split("\n");
  return [
    `${printable.location === undefined ? "" : `${printable.location}: `}error ${printable.tag}: ${firstLine}`,
    ...continuationLines.map((line) => `  ${line}`),
  ].join("\n");
};

export const listedViolations = (violations: readonly Parameters<typeof printableError>[0][]) =>
  violations.map((found) => formattedError(printableError(found))).join("\n");

export const printableErrorWith = (
  printable: Parameters<typeof formattedError>[0],
  replacement: { readonly tag?: string; readonly message?: string },
) => ({
  tag: replacement.tag ?? printable.tag,
  ...(printable.location === undefined ? {} : { location: printable.location }),
  message: replacement.message ?? printable.message,
});
