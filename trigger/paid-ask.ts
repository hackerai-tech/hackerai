import { createChatTriggerTask } from "./chat-task";

export const paidAskTask = createChatTriggerTask({
  id: "paid-ask",
  defaultMode: "ask",
});
