export const SIDEBAR_PINNED_DROP_ID = "sidebar-drop:pinned";
export const SIDEBAR_TASKS_DROP_ID = "sidebar-drop:tasks";
export const SIDEBAR_MOUSE_DRAG_DISTANCE = 8;
export const SIDEBAR_TOUCH_DRAG_DELAY = 250;
export const SIDEBAR_TOUCH_DRAG_TOLERANCE = 5;

export interface SidebarChatDragData {
  type: "sidebar-chat";
  chatId: string;
  isPinned: boolean;
  projectId?: string;
  title: string;
}

export interface SidebarChatDropData {
  type: "sidebar-chat-drop";
  onDrop: (chat: SidebarChatDragData) => Promise<void> | void;
}

export function getSidebarChatDragData(
  value: unknown,
): SidebarChatDragData | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "sidebar-chat" ||
    !("chatId" in value) ||
    typeof value.chatId !== "string" ||
    !("isPinned" in value) ||
    typeof value.isPinned !== "boolean" ||
    !("title" in value) ||
    typeof value.title !== "string"
  ) {
    return undefined;
  }

  return value as SidebarChatDragData;
}

export function getSidebarChatDropData(
  value: unknown,
): SidebarChatDropData | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "sidebar-chat-drop" ||
    !("onDrop" in value) ||
    typeof value.onDrop !== "function"
  ) {
    return undefined;
  }

  return value as SidebarChatDropData;
}

export function dispatchSidebarChatDrop(
  activeData: unknown,
  dropData: unknown,
): boolean {
  const chat = getSidebarChatDragData(activeData);
  const dropTarget = getSidebarChatDropData(dropData);
  if (!chat || !dropTarget) return false;

  void dropTarget.onDrop(chat);
  return true;
}
