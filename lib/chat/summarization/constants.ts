// Keep last N messages unsummarized for context
export const MESSAGES_TO_KEEP_UNSUMMARIZED = 0;

// Summarize at 90% of token limit to leave buffer for current response
export const SUMMARIZATION_THRESHOLD_PERCENTAGE = 0.9;

// Keep persisted todos useful in the synthetic summary without letting stored
// todo payloads bypass chat token budgeting.
export const SUMMARY_TODO_MAX_ITEMS = 100;
export const SUMMARY_TODO_CONTENT_MAX_TOKENS = 256;
export const SUMMARY_TODO_BLOCK_MAX_TOKENS = 4096;

// Bound individual tool results fed into the summarizer. Agent tool outputs can
// be enormous, and summarization should see a preview rather than raw logs.
export const SUMMARY_TOOL_OUTPUT_MAX_TOKENS = 2048;
