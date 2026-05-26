import { createChatTriggerTask } from "./chat-task";

export const agentLongTask = createChatTriggerTask({
  id: "agent-long",
  defaultMode: "agent",
});
