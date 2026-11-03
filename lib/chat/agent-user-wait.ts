export type ActiveAgentUserWait = {
  runId: string;
  toolCallId: string;
  status: "waiting" | "submitting";
};
