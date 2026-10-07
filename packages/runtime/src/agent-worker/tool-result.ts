export function jsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }],
    details: (value ?? null) as never,
  };
}
