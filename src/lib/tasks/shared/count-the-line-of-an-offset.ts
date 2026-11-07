const LINE_BREAK = /\n/gu;

export const lineNumbersIn = (text: string) => {
  const lineStarts = [0, ...Array.from(text.matchAll(LINE_BREAK), (match) => match.index + 1)];
  const linesStartingBy = (offset: number, low: number, high: number): number => {
    if (low >= high) {
      return low;
    }
    const middle = (low + high) >>> 1;
    return (lineStarts[middle] ?? 0) <= offset
      ? linesStartingBy(offset, middle + 1, high)
      : linesStartingBy(offset, low, middle);
  };
  return (offset: number) => linesStartingBy(offset, 0, lineStarts.length);
};

export const lineOfTheFirstLabel = (
  text: string,
  [label]: readonly { readonly start: number }[],
) => (label === undefined ? {} : { line: lineNumbersIn(text)(label.start) });
