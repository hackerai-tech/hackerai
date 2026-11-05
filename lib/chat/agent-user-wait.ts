export const MAX_AGENT_USER_REPLY_LENGTH = 20_000;

export type ActiveAgentUserWait = {
  runId: string;
  toolCallId: string;
  status: "waiting" | "submitting";
};
