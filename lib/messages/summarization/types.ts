import type { UIMessage } from "ai";

export type SummaryChunk = {
  text: string;
  lastMessageId: string;
};

export type SummarizationResult = {
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryChunks: SummaryChunk[] | null;
};
