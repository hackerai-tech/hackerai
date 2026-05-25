// Some providers emit a stray empty `tool-input-delta` AFTER `tool-input-available`.
// The AI SDK treats `tool-input-delta` as authoritative and unconditionally
// flips the part back to `input-streaming` (see processUIMessageStream), which
// hides the already-complete command in tools like TerminalToolHandler.
// We dedupe at the transport layer: once `tool-input-available` is seen for a
// given toolCallId, subsequent `tool-input-delta`s for that id are dropped.

type ChunkLike = { type?: string; toolCallId?: string };

export type ToolInputDedupFilter = {
  shouldDrop: (chunk: ChunkLike) => boolean;
};

export const createToolInputDedupFilter = (): ToolInputDedupFilter => {
  const completed = new Set<string>();
  return {
    shouldDrop(chunk) {
      const id = chunk.toolCallId;
      if (typeof id !== "string") return false;
      if (chunk.type === "tool-input-delta" && completed.has(id)) {
        return true;
      }
      if (chunk.type === "tool-input-available") {
        completed.add(id);
      }
      return false;
    },
  };
};
