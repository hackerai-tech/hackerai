import type { UserInputQuestion } from "./user-input-questions";

export const MAX_AGENT_USER_REPLY_LENGTH = 20_000;

export type ActiveAgentUserWait = {
  questions?: UserInputQuestion[];
  runId: string;
  toolCallId: string;
  status: "waiting" | "submitting";
};
