export const SIDEBAR_CHAT_DRAG_TYPE = "application/x-hackerai-chat-id";
export const SIDEBAR_CHAT_DRAG_PROJECT_TYPE =
  "application/x-hackerai-project-id";

export function setSidebarChatDragData(
  dataTransfer: DataTransfer,
  chatId: string,
  projectId?: string,
): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(SIDEBAR_CHAT_DRAG_TYPE, chatId);
  if (projectId) {
    dataTransfer.setData(SIDEBAR_CHAT_DRAG_PROJECT_TYPE, projectId);
  }
}

export function hasSidebarChatDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(SIDEBAR_CHAT_DRAG_TYPE);
}

export function getSidebarChatDragProjectId(
  dataTransfer: DataTransfer,
): string | undefined {
  const projectId = dataTransfer.getData(SIDEBAR_CHAT_DRAG_PROJECT_TYPE);
  return projectId || undefined;
}
