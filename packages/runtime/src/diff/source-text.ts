export function unquote(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  return first && last && first === last && ['"', "'", "`"].includes(first)
    ? value.slice(1, -1)
    : value;
}
