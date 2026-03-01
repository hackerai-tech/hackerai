// Keep last N messages unsummarized for context
export const MESSAGES_TO_KEEP_UNSUMMARIZED = 2;

// Fraction of the model's max token limit used as the summarization trigger.
// Summarization fires when provider-reported input tokens exceed this ratio of the limit.
export const SUMMARIZATION_THRESHOLD_PERCENTAGE = 0.9;

// Keep last N steps unsummarized during step-level summarization.
// Set to 0 to summarize all completed steps (most aggressive compression).
export const STEPS_TO_KEEP_UNSUMMARIZED = 2;
