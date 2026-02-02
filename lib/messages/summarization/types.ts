import type { UIMessage } from "ai";

export type SummarizationResult = {
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryTexts: string[] | null;
};
