export const SIDEBAR_CHAT_DRAG_TYPE = "application/x-hackerai-chat-id";

export function setSidebarChatDragData(
  dataTransfer: DataTransfer,
  chatId: string,
): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(SIDEBAR_CHAT_DRAG_TYPE, chatId);
}

export function hasSidebarChatDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(SIDEBAR_CHAT_DRAG_TYPE);
}
