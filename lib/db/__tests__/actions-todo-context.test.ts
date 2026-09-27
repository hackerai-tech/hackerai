const mockQuery = jest.fn();
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("../convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery }),
  setConvexUrl: jest.fn(),
}));
jest.mock("@/lib/chat/chat-processor", () => ({
  fixIncompleteMessageParts: (x: unknown) => x,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import { getMessagesByChatId } from "../actions";

it.each(["agent", "ask"] as const)(
  "reattaches current stored todos when resuming a saved summary in %s",
  async (mode) => {
    mockQuery.mockReset();
    const todos = [
      {
        id: "opaque-42",
        content: "Verify webhook replay defense",
        status: "pending",
        sourceMessageId: "old-assistant",
      },
    ];
    mockQuery
      .mockResolvedValueOnce({
        id: "chat-test",
        todos,
        latest_summary_id: "summary-test",
      })
      .mockResolvedValueOnce({
        summary_text: "The assessment is ongoing.",
        summary_up_to_message_id: "old-assistant",
      })
      .mockResolvedValueOnce({
        page: [
          {
            id: "old-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "Working on it." }],
          },
        ],
        isDone: true,
        continueCursor: null,
      });
    const result = await getMessagesByChatId({
      chatId: "chat-test",
      userId: "user-test",
      subscription: "pro",
      mode,
      newMessages: [
        {
          id: "new-user",
          role: "user",
          parts: [{ type: "text", text: "Continue." }],
        },
      ],
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(result.chat?.todos).toEqual(todos);
    const context = JSON.stringify(result.truncatedMessages);
    expect(context).toContain("<context_summary>");
    expect(context).toContain("<current_todos>");
    expect(context).toContain("opaque-42");
    expect(context).toContain("Verify webhook replay defense");
  },
);
