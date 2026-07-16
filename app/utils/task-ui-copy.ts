const SUPPORT_CHAT_PLACEHOLDER = "__HACKERAI_SUPPORT_CHAT__";

export function formatTaskUiCopy(copy: string): string {
  return copy
    .replace(/support via chat/gi, SUPPORT_CHAT_PLACEHOLDER)
    .replace(/\bChats\b/g, "Tasks")
    .replace(/\bchats\b/g, "tasks")
    .replace(/\bChat\b/g, "Task")
    .replace(/\bchat\b/g, "task")
    .replaceAll(SUPPORT_CHAT_PLACEHOLDER, "support via chat");
}

export function formatTaskTitle(title: string): string {
  return title === "New Chat" ? "New Task" : title;
}
