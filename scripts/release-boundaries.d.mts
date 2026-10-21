export function clientServerLeaks(
  bundle: Record<string, { type: "chunk"; modules: Record<string, { renderedLength: number }> } | { type: "asset" }>,
): string[];
