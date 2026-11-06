import type { UserInputQuestion } from "./user-input-questions";

export const MAX_AGENT_USER_REPLY_LENGTH = 20_000;

export class AgentReplyConflictError extends Error {
  constructor() {
    super("A different reply already owns this wait");
    this.name = "AgentReplyConflictError";
  }
}

export type ActiveAgentUserWait = {
  questions?: UserInputQuestion[];
  runId: string;
  toolCallId: string;
  status: "waiting" | "submitting";
};
