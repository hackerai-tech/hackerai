type ContentChunkLike = {
  type?: string;
  id?: string;
};

type ContentPartType = "text" | "reasoning";

const CONTENT_PART_TYPES: readonly ContentPartType[] = ["text", "reasoning"];
const CONTENT_SEQUENCE_RESET_CHUNK_TYPES = new Set([
  "finish-step",
  "finish",
  "abort",
  "error",
]);

export const createContentSequenceGuard = () => {
  const activePartIds: Record<ContentPartType, Set<string>> = {
    text: new Set<string>(),
    reasoning: new Set<string>(),
  };

  return {
    shouldDrop(chunk: ContentChunkLike): boolean {
      for (const partType of CONTENT_PART_TYPES) {
        const startType = `${partType}-start`;
        const deltaType = `${partType}-delta`;
        const endType = `${partType}-end`;

        if (chunk.type === startType) {
          if (
            typeof chunk.id !== "string" ||
            activePartIds[partType].has(chunk.id)
          ) {
            return true;
          }

          activePartIds[partType].add(chunk.id);
          return false;
        }

        if (chunk.type === deltaType || chunk.type === endType) {
          if (
            typeof chunk.id !== "string" ||
            !activePartIds[partType].has(chunk.id)
          ) {
            return true;
          }

          if (chunk.type === endType) {
            activePartIds[partType].delete(chunk.id);
          }
          return false;
        }
      }

      if (chunk.type && CONTENT_SEQUENCE_RESET_CHUNK_TYPES.has(chunk.type)) {
        for (const partType of CONTENT_PART_TYPES) {
          activePartIds[partType].clear();
        }
      }

      return false;
    },
  };
};
