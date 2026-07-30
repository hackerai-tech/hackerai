import { describe, expect, it, jest } from "@jest/globals";
import {
  dispatchSidebarChatDrop,
  getSidebarChatDragData,
  getSidebarChatDropData,
  SIDEBAR_MOUSE_DRAG_DISTANCE,
  SIDEBAR_TOUCH_DRAG_DELAY,
  SIDEBAR_TOUCH_DRAG_TOLERANCE,
  type SidebarChatDragData,
  type SidebarChatDropData,
} from "../sidebar-chat-drag";

const chat: SidebarChatDragData = {
  type: "sidebar-chat",
  chatId: "chat-1",
  isPinned: false,
  projectId: "project-1",
  title: "Target notes",
};

describe("sidebar chat drag data", () => {
  it("requires intentional mouse or touch activation", () => {
    expect(SIDEBAR_MOUSE_DRAG_DISTANCE).toBe(8);
    expect(SIDEBAR_TOUCH_DRAG_DELAY).toBe(250);
    expect(SIDEBAR_TOUCH_DRAG_TOLERANCE).toBe(5);
  });

  it("recognizes typed sensor drag and drop data", () => {
    const onDrop = jest.fn();
    const dropTarget: SidebarChatDropData = {
      type: "sidebar-chat-drop",
      onDrop,
    };

    expect(getSidebarChatDragData(chat)).toBe(chat);
    expect(getSidebarChatDropData(dropTarget)).toBe(dropTarget);
    expect(dispatchSidebarChatDrop(chat, dropTarget)).toBe(true);
    expect(onDrop).toHaveBeenCalledWith(chat);
  });

  it("ignores unrelated or incomplete drag data", () => {
    const onDrop = jest.fn();
    const dropTarget: SidebarChatDropData = {
      type: "sidebar-chat-drop",
      onDrop,
    };

    expect(getSidebarChatDragData({ type: "sidebar-chat" })).toBeUndefined();
    expect(
      getSidebarChatDropData({ type: "sidebar-chat-drop" }),
    ).toBeUndefined();
    expect(dispatchSidebarChatDrop({ type: "file" }, dropTarget)).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
