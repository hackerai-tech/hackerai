// Keep last N messages unsummarized for context
export const MESSAGES_TO_KEEP_UNSUMMARIZED = 0;

// Reserve context headroom before compaction so the next request still has
// enough room for tool schemas, provider formatting overhead, and output.
export const SUMMARIZATION_RESERVED_MAX_TOKENS = 20_000;
export const SUMMARIZATION_RESERVED_TOKEN_PERCENTAGE = 0.1;
export const DEV_SUMMARIZATION_THRESHOLD_TOKENS_ENV =
  "NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS";
export const SUMMARY_PROMPT_VERSION = "2026-06-11.opencode-anchored-summary-v2";

const getDevSummarizationThresholdTokens = (
  maxTokens: number,
): number | null => {
  if (process.env.NODE_ENV !== "development") return null;

  const configuredTokens = Number.parseInt(
    process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS ?? "",
    10,
  );

  if (!Number.isFinite(configuredTokens) || configuredTokens <= 0) {
    return null;
  }

  return Math.min(maxTokens, Math.floor(configuredTokens));
};

export const getSummarizationThresholdTokens = (maxTokens: number): number => {
  const usableMaxTokens = Math.max(0, maxTokens);
  const devThresholdTokens =
    getDevSummarizationThresholdTokens(usableMaxTokens);
  if (devThresholdTokens !== null) return devThresholdTokens;

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

// Bound the entire model-message projection sent to the summarizer. This is a
// second safety net after per-tool/media compaction.
export const SUMMARY_INPUT_MAX_TOKENS = 64_000;
export const SUMMARY_OVERFLOW_TEXT_PART_MAX_TOKENS = 1024;
export const SUMMARY_OVERFLOW_TOOL_OUTPUT_MAX_TOKENS = 512;

// A single Agent stream may compact repeatedly as tool work grows. Keep this
// bounded so a provider whose fixed prompt/tool overhead cannot be reduced does
// not enter an endless summarize/retry loop. Once exhausted, the existing
// context-limit continuation starts a fresh backend run.
export const MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM = 8;

// A replacement checkpoint must remove at least 10% of serialized context.
export const ROLLING_COMPACTION_MAX_SIZE_RATIO = 0.9;

export const getSummaryInputMaxTokens = (maxTokens: number): number =>
  Math.min(
    SUMMARY_INPUT_MAX_TOKENS,
    getSummarizationThresholdTokens(maxTokens),
  );
