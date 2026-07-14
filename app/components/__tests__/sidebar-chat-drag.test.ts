import { describe, expect, it, jest } from "@jest/globals";
import {
  hasSidebarChatDragData,
  setSidebarChatDragData,
  SIDEBAR_CHAT_DRAG_TYPE,
} from "../sidebar-chat-drag";

describe("sidebar chat drag data", () => {
  it("writes a move payload that project rows recognize", () => {
    const types: string[] = [];
    const setData = jest.fn((type: string) => {
      if (!types.includes(type)) types.push(type);
    });
    const dataTransfer = {
      effectAllowed: "none",
      setData,
      types,
    } as unknown as DataTransfer;

    setSidebarChatDragData(dataTransfer, "chat-1");

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(setData).toHaveBeenCalledWith(SIDEBAR_CHAT_DRAG_TYPE, "chat-1");
    expect(hasSidebarChatDragData(dataTransfer)).toBe(true);
  });
});
