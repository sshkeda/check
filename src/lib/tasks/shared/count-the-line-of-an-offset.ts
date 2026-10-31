export const lineNumberAt = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length;
