import type { ChatMessage } from "@/types";
import {
  deriveChatTimelineRows,
  type ChatTimelineRow,
} from "../message-timeline-rows";
import {
  deriveMessageNavigatorItems,
  resolveMessageNavigatorHasPersistentGutter,
  resolveMessageNavigatorHeightStyle,
  resolveMessageNavigatorHitStripWidth,
  resolveMessageNavigatorIndexFromPointer,
  resolveMessageNavigatorTopPercent,
} from "../message-navigator";

const message = (
  id: string,
  role: ChatMessage["role"],
  text: string,
): ChatMessage =>
  ({
    id,
    role,
    parts: [{ type: "text", text }],
  }) as ChatMessage;

const deriveRows = (messages: ChatMessage[]): ChatTimelineRow[] =>
  deriveChatTimelineRows({
    messages,
    status: "ready",
    lastAssistantMessageIndex: undefined,
    expandedAgentMessageIds: new Set(),
  });

describe("message navigator logic", () => {
  it("builds one destination per user turn with compact previews", () => {
    const messages = [
      message("user-1", "user", "  First\n\nquestion  "),
      message("assistant-1", "assistant", "First answer"),
      message("assistant-2", "assistant", "Final\nanswer for turn one"),
      message("user-2", "user", "Second question"),
      message("assistant-3", "assistant", "Second answer"),
    ];

    expect(deriveMessageNavigatorItems(messages, deriveRows(messages))).toEqual(
      [
        {
          id: "user-1",
          rowIndex: 0,
          userText: "First question",
          assistantText: "Final answer for turn one",
        },
        {
          id: "user-2",
          rowIndex: 3,
          userText: "Second question",
          assistantText: "Second answer",
        },
      ],
    );
  });

  it("omits user messages without a rendered timeline destination", () => {
    const messages = [
      message("user-1", "user", "First"),
      message("assistant-1", "assistant", "Answer"),
      message("user-2", "user", "Second"),
    ];
    const rows = deriveRows(messages).filter(
      (row) => row.kind !== "message" || row.message.id !== "user-1",
    );

    expect(deriveMessageNavigatorItems(messages, rows)).toEqual([
      {
        id: "user-2",
        rowIndex: 1,
        userText: "Second",
        assistantText: null,
      },
    ]);
  });

  it("resolves rail geometry and bounded pointer destinations", () => {
    expect(resolveMessageNavigatorHeightStyle(5)).toBe(
      "min(44px, calc(100vh - 18rem))",
    );
    expect(resolveMessageNavigatorTopPercent(2, 5)).toBe(50);
    expect(
      resolveMessageNavigatorIndexFromPointer({
        itemCount: 5,
        railTop: 100,
        railHeight: 200,
        pointerY: 250,
      }),
    ).toBe(3);
    expect(
      resolveMessageNavigatorIndexFromPointer({
        itemCount: 5,
        railTop: 100,
        railHeight: 200,
        pointerY: 999,
      }),
    ).toBe(4);
    expect(resolveMessageNavigatorHasPersistentGutter(863)).toBe(false);
    expect(resolveMessageNavigatorHasPersistentGutter(864)).toBe(true);
    expect(resolveMessageNavigatorHitStripWidth(768)).toBe(0);
    expect(resolveMessageNavigatorHitStripWidth(820)).toBe(14);
    expect(resolveMessageNavigatorHitStripWidth(872)).toBe(40);
  });
});
