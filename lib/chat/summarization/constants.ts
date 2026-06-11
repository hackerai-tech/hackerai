// Keep last N messages unsummarized for context
export const MESSAGES_TO_KEEP_UNSUMMARIZED = 0;

// Reserve context headroom before compaction so the next request still has
// enough room for tool schemas, provider formatting overhead, and output.
export const SUMMARIZATION_RESERVED_MAX_TOKENS = 20_000;
export const SUMMARIZATION_RESERVED_TOKEN_PERCENTAGE = 0.1;

export const getSummarizationThresholdTokens = (maxTokens: number): number => {
  const usableMaxTokens = Math.max(0, maxTokens);
  const reservedTokens = Math.min(
    SUMMARIZATION_RESERVED_MAX_TOKENS,
    Math.floor(usableMaxTokens * SUMMARIZATION_RESERVED_TOKEN_PERCENTAGE),
  );
  return Math.max(0, usableMaxTokens - reservedTokens);
};

// Keep persisted todos useful in the synthetic summary without letting stored
// todo payloads bypass chat token budgeting.
export const SUMMARY_TODO_MAX_ITEMS = 100;
export const SUMMARY_TODO_CONTENT_MAX_TOKENS = 256;
export const SUMMARY_TODO_BLOCK_MAX_TOKENS = 4096;

// Bound individual tool results fed into the summarizer. Agent tool outputs can
// be enormous, and summarization should see a preview rather than raw logs.
export const SUMMARY_TOOL_OUTPUT_MAX_TOKENS = 2048;
