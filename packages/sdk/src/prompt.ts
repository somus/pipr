/** Removes common leading indentation from multiline text. */
export function stripCommonIndent(value: string): string {
  const lines = value.replaceAll("\t", "  ").split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const indent = Math.min(...nonEmpty.map((line) => line.match(/^ */)?.[0].length ?? 0));
  return lines.map((line) => line.slice(indent)).join("\n");
}
