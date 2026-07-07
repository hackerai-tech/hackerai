type ReasoningChunkLike = {
  type?: string;
  id?: string;
};

const REASONING_SEQUENCE_RESET_CHUNK_TYPES = new Set([
  "finish-step",
  "finish",
  "abort",
  "error",
]);

export const createReasoningSequenceGuard = () => {
  const activeReasoningPartIds = new Set<string>();

  return {
    shouldDrop(chunk: ReasoningChunkLike): boolean {
      if (chunk.type === "reasoning-start") {
        if (typeof chunk.id !== "string") return true;
        activeReasoningPartIds.add(chunk.id);
        return false;
      }

      if (chunk.type === "reasoning-delta" || chunk.type === "reasoning-end") {
        if (
          typeof chunk.id !== "string" ||
          !activeReasoningPartIds.has(chunk.id)
        ) {
          return true;
        }

        if (chunk.type === "reasoning-end") {
          activeReasoningPartIds.delete(chunk.id);
        }
        return false;
      }

      if (
        chunk.type &&
        REASONING_SEQUENCE_RESET_CHUNK_TYPES.has(chunk.type)
      ) {
        activeReasoningPartIds.clear();
      }

      return false;
    },
  };
};
