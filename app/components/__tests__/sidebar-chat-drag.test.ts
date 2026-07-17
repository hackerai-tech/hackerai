import { describe, expect, it, jest } from "@jest/globals";
import {
  getSidebarChatDragProjectId,
  hasSidebarChatDragData,
  setSidebarChatDragData,
  SIDEBAR_CHAT_DRAG_PROJECT_TYPE,
  SIDEBAR_CHAT_DRAG_TYPE,
} from "../sidebar-chat-drag";

describe("sidebar chat drag data", () => {
  it("writes a move payload that project rows recognize", () => {
    const types: string[] = [];
    const values = new Map<string, string>();
    const setData = jest.fn((type: string, value: string) => {
      if (!types.includes(type)) types.push(type);
      values.set(type, value);
    });
    const dataTransfer = {
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData,
      types,
    } as unknown as DataTransfer;

    setSidebarChatDragData(dataTransfer, "chat-1", "project-1");

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(setData).toHaveBeenCalledWith(SIDEBAR_CHAT_DRAG_TYPE, "chat-1");
    expect(setData).toHaveBeenCalledWith(
      SIDEBAR_CHAT_DRAG_PROJECT_TYPE,
      "project-1",
    );
    expect(hasSidebarChatDragData(dataTransfer)).toBe(true);
    expect(getSidebarChatDragProjectId(dataTransfer)).toBe("project-1");
  });
});
