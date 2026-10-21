export function clientServerLeaks(bundle) {
  return Object.values(bundle).flatMap((chunk) =>
    chunk.type === "chunk"
      ? Object.entries(chunk.modules)
          .filter(([id, module]) => id.includes("__vite-browser-external") && module.renderedLength > 0)
          .map(([id]) => id)
      : [],
  );
}
