export const POST_SUMMARIZATION_CONTINUATION_PROMPT =
  "<system-reminder>\n" +
  "The conversation was compacted so the agent can continue with a smaller context. " +
  "Continue the interrupted task now. Do not reply with an acknowledgement, apology, " +
  "or a promise that you will continue. If action is still needed, call the next required tool. " +
  "If the task is complete, provide the final result or deliverable. Do not restart completed work.\n" +
  "</system-reminder>";

const MAX_FILLER_CHARS = 500;

const ENGLISH_FILLER_RE =
  /\b(?:i(?:'|\u2019)?ll|i will|let me|i am going to|i'm going to|i\u2019ll go|i will go|going to|go ahead|continue|proceed|start|work on|look into|fix this|get to it|take care of it)\b/i;

const PERSIAN_FILLER_RE =
  /(?:\u0639\u0630\u0631|\u0645\u06cc[\u200c\s]?\u062e\u0648\u0627\u0645|\u0645\u06cc\u0631\u0645|\u0633\u0631\u0627\u063a|\u0627\u062f\u0627\u0645\u0647|\u0628\u0630\u0627\u0631|\u0627\u0644\u0627\u0646|\u0628\u0627\u0634\u0647|\u0641\u06cc\u06a9\u0633|\u0628\u0631\u0631\u0633\u06cc)/u;

const SETUP_ENDING_RE = /[:：]\s*$/;

const normalizeText = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

export const isPostSummarizationFillerText = (text: string): boolean => {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (normalized.length > MAX_FILLER_CHARS) return false;

  const hasFillerPhrase =
    ENGLISH_FILLER_RE.test(normalized) || PERSIAN_FILLER_RE.test(normalized);
  if (!hasFillerPhrase) return false;

  return normalized.length <= 280 || SETUP_ENDING_RE.test(normalized);
};

export const isIncompletePostSummarizationStop = ({
  finishReason,
  text,
  toolCallCount,
}: {
  finishReason: string | undefined;
  text: string;
  toolCallCount: number;
}): boolean =>
  finishReason === "stop" &&
  toolCallCount === 0 &&
  isPostSummarizationFillerText(text);
