// Keep last N messages unsummarized for context
export const MESSAGES_TO_KEEP_UNSUMMARIZED = 2;

// Summarize at 90% of token limit to leave buffer for current response
// This provides ~3.2k tokens (for 32k Pro plan) for assistant's response and summary
export const SUMMARIZATION_THRESHOLD_PERCENTAGE = 0.9;

// Number of messages per summarization chunk
export const SUMMARIZATION_CHUNK_SIZE = 10;
