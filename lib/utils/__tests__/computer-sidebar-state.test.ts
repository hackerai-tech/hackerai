import {
  clearPersistedComputerSidebarState,
  getRestoredComputerSidebarContent,
  getSidebarToolCallId,
  readPersistedComputerSidebarState,
  writePersistedComputerSidebarState,
} from "../computer-sidebar-state";
import type { SidebarContent } from "@/types/chat";

const terminalTool = (
  toolCallId: string,
  command = toolCallId,
): SidebarContent => ({
  toolCallId,
  command,
  output: "",
  isExecuting: false,
});

describe("computer-sidebar-state", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("restores the exact selected tool when replay reaches it", () => {
    const persisted = {
      chatId: "chat-1",
      toolCallId: "tool-2",
      followLive: false,
      updatedAt: 1000,
    };
    const toolExecutions = [
      terminalTool("tool-1"),
      terminalTool("tool-2", "target command"),
      terminalTool("tool-3"),
    ];

    expect(
      getRestoredComputerSidebarContent({
        chatId: "chat-1",
        persisted,
        toolExecutions,
        now: 2000,
      }),
    ).toEqual(toolExecutions[1]);
  });

  it("waits when replay has not reached the selected tool", () => {
    const persisted = {
      chatId: "chat-1",
      toolCallId: "tool-3",
      followLive: false,
      updatedAt: 1000,
    };

    expect(
      getRestoredComputerSidebarContent({
        chatId: "chat-1",
        persisted,
        toolExecutions: [terminalTool("tool-1"), terminalTool("tool-2")],
        now: 2000,
      }),
    ).toBeNull();
  });

  it("restores the newest tool when the sidebar was following live output", () => {
    const persisted = {
      chatId: "chat-1",
      toolCallId: "tool-1",
      followLive: true,
      updatedAt: 1000,
    };
    const toolExecutions = [terminalTool("tool-1"), terminalTool("tool-2")];

    expect(
      getRestoredComputerSidebarContent({
        chatId: "chat-1",
        persisted,
        toolExecutions,
        now: 2000,
      }),
    ).toEqual(toolExecutions[1]);
  });

  it("ignores stale or cross-chat sidebar records", () => {
    const persisted = {
      chatId: "chat-1",
      toolCallId: "tool-1",
      followLive: false,
      updatedAt: 1000,
    };

    expect(
      getRestoredComputerSidebarContent({
        chatId: "chat-2",
        persisted,
        toolExecutions: [terminalTool("tool-1")],
        now: 2000,
      }),
    ).toBeNull();

    expect(
      getRestoredComputerSidebarContent({
        chatId: "chat-1",
        persisted,
        toolExecutions: [terminalTool("tool-1")],
        now: 1000 + 6 * 60 * 60 * 1000 + 1,
      }),
    ).toBeNull();
  });

  it("round-trips sidebar state through sessionStorage and clears by chat", () => {
    const now = Date.now();
    const state = {
      chatId: "chat-1",
      toolCallId: "tool-1",
      followLive: false,
      updatedAt: now,
    };

    writePersistedComputerSidebarState(state);
    expect(readPersistedComputerSidebarState(now + 1000)).toEqual(state);

    clearPersistedComputerSidebarState("other-chat");
    expect(readPersistedComputerSidebarState(now + 1000)).toEqual(state);

    clearPersistedComputerSidebarState("chat-1");
    expect(readPersistedComputerSidebarState(now + 1000)).toBeNull();
  });

  it("extracts only concrete tool call ids from sidebar content", () => {
    expect(getSidebarToolCallId(terminalTool("tool-1"))).toBe("tool-1");
    expect(
      getSidebarToolCallId({
        path: "/tmp/file.txt",
        content: "hello",
        action: "reading",
      }),
    ).toBeNull();
  });
});
