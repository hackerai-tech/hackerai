// Keep last N messages unsummarized for context
export const MESSAGES_TO_KEEP_UNSUMMARIZED = 2;

// Fraction of the model's max token limit used as the summarization trigger.
// Summarization fires when total token usage exceeds this percentage of the limit (i.e. 7%).
export const SUMMARIZATION_THRESHOLD_PERCENTAGE = 0.1;

// Keep last N steps unsummarized during step-level summarization
export const STEPS_TO_KEEP_UNSUMMARIZED = 0;
