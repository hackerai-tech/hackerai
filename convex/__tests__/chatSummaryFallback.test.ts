import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    array: jest.fn(() => "array"),
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    any: jest.fn(() => "any"),
  },
  ConvexError: class ConvexError extends Error {
    data: any;
    constructor(data: any) {
      super(typeof data === "string" ? data : data.message);
      this.data = data;
      this.name = "ConvexError";
    }
  },
}));
jest.mock("../_generated/api", () => ({
  internal: {
    messages: {
      verifyChatOwnership: "internal.messages.verifyChatOwnership",
    },
    s3Cleanup: {
      deleteS3ObjectAction: "internal.s3Cleanup.deleteS3ObjectAction",
    },
  },
}));
jest.mock("../chats", () => ({
  ...(jest.requireActual("../chats") as Record<string, any>),
  validateServiceKey: jest.fn(),
}));

const SERVICE_KEY = "test-service-key";
process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));
jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

const CHAT_ID = "chat-001";
const USER_ID = "user-123";
const CHAT_DOC_ID = "chat-doc-id" as Id<"chats">;
const SUMMARY_DOC_ID = "summary-doc-id" as Id<"chat_summaries">;

function makeSummaryDoc(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    _id: SUMMARY_DOC_ID,
    chat_id: CHAT_ID,
    summary_text: "current summary",
    summary_up_to_message_id: "msg-cutoff",
    previous_summaries: [],
    ...overrides,
  };
}

function makeChatDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: CHAT_DOC_ID,
    id: CHAT_ID,
    user_id: USER_ID,
    title: "Test Chat",
    update_time: 1000,
    latest_summary_id: SUMMARY_DOC_ID,
    ...overrides,
  };
}

describe("saveLatestSummary — previous_summaries chain", () => {
  let mockCtx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    mockCtx = {
      db: {
        query: jest.fn(),
        get: jest.fn<any>().mockResolvedValue(null),
        insert: jest
          .fn<any>()
          .mockResolvedValue("new-summary-id" as Id<"chat_summaries">),
        patch: jest.fn<any>().mockResolvedValue(undefined),
        delete: jest.fn<any>().mockResolvedValue(undefined),
      },
    };

    const withIndexMock = jest.fn().mockReturnValue({
      first: jest.fn<any>().mockResolvedValue(null),
    });
    mockCtx.db.query.mockReturnValue({ withIndex: withIndexMock });
  });

  function setupChatQuery(chat: Record<string, any> | null): void {
    const withIndexMock = jest.fn().mockReturnValue({
      first: jest.fn<any>().mockResolvedValue(chat),
    });
    mockCtx.db.query.mockReturnValue({ withIndex: withIndexMock });
  }

  it("should set previous_summaries to [] when no existing summary", async () => {
    const chat = makeChatDoc({ latest_summary_id: undefined });
    setupChatQuery(chat);

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "new summary",
      summaryUpToMessageId: "msg-10",
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.objectContaining({
        previous_summaries: [],
      }),
    );
  });

  it("should push old summary into previous_summaries[0] on second save", async () => {
    const chat = makeChatDoc();
    setupChatQuery(chat);

    const oldSummary = makeSummaryDoc({
      summary_text: "old text",
      summary_up_to_message_id: "msg-5",
      previous_summaries: [],
    });
    mockCtx.db.get.mockResolvedValue(oldSummary);

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "new summary",
      summaryUpToMessageId: "msg-10",
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.objectContaining({
        previous_summaries: [
          { summary_text: "old text", summary_up_to_message_id: "msg-5" },
        ],
      }),
    );
  });

  it("should preserve the chain: [old, ...old_previous_summaries]", async () => {
    const chat = makeChatDoc();
    setupChatQuery(chat);

    const existingChain = [
      { summary_text: "even-older", summary_up_to_message_id: "msg-1" },
    ];
    const oldSummary = makeSummaryDoc({
      summary_text: "old text",
      summary_up_to_message_id: "msg-5",
      previous_summaries: existingChain,
    });
    mockCtx.db.get.mockResolvedValue(oldSummary);

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "newest",
      summaryUpToMessageId: "msg-10",
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.objectContaining({
        previous_summaries: [
          { summary_text: "old text", summary_up_to_message_id: "msg-5" },
          { summary_text: "even-older", summary_up_to_message_id: "msg-1" },
        ],
      }),
    );
  });

  it("should truncate previous_summaries at MAX_PREVIOUS_SUMMARIES (10)", async () => {
    const chat = makeChatDoc();
    setupChatQuery(chat);

    const existingChain = Array.from({ length: 11 }, (_, i) => ({
      summary_text: `prev-${i}`,
      summary_up_to_message_id: `msg-prev-${i}`,
    }));
    const oldSummary = makeSummaryDoc({
      summary_text: "old text",
      summary_up_to_message_id: "msg-5",
      previous_summaries: existingChain,
    });
    mockCtx.db.get.mockResolvedValue(oldSummary);

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "newest",
      summaryUpToMessageId: "msg-10",
    });

    const insertCall = mockCtx.db.insert.mock.calls[0];
    const insertedDoc = insertCall[1];
    expect(insertedDoc.previous_summaries).toHaveLength(10);
    expect(insertedDoc.previous_summaries[0]).toEqual({
      summary_text: "old text",
      summary_up_to_message_id: "msg-5",
    });
  });
});

describe("checkAndInvalidateSummary via deleteLastAssistantMessage", () => {
  let mockCtx: any;

  const ASSISTANT_MSG_ID = "asst-msg-1" as Id<"messages">;
  const CUTOFF_MSG_ID = "msg-cutoff";

  function makeAssistantMessage(
    overrides: Record<string, any> = {},
  ): Record<string, any> {
    return {
      _id: ASSISTANT_MSG_ID,
      id: "asst-msg-1",
      chat_id: CHAT_ID,
      user_id: USER_ID,
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      _creationTime: 5000,
      file_ids: undefined,
      feedback_id: undefined,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    mockCtx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({ subject: USER_ID }),
      },
      db: {
        query: jest.fn(),
        get: jest.fn<any>().mockResolvedValue(null),
        patch: jest.fn<any>().mockResolvedValue(undefined),
        delete: jest.fn<any>().mockResolvedValue(undefined),
        insert: jest.fn<any>().mockResolvedValue("new-id"),
      },
      runQuery: jest.fn<any>().mockResolvedValue(true),
      scheduler: {
        runAfter: jest.fn<any>().mockResolvedValue(undefined),
      },
      storage: {
        delete: jest.fn<any>().mockResolvedValue(undefined),
      },
    };
  });

  /**
   * Sets up the chained mock for ctx.db.query so that different tables/indexes
   * return different results. Call order within deleteLastAssistantMessage:
   *   1. messages.by_chat_id (with filter+order+first) -> last assistant msg
   *   2. chats.by_chat_id (first) -> chat doc              [inside checkAndInvalidateSummary]
   *   3. messages.by_message_id (first) -> cutoff message   [inside checkAndInvalidateSummary]
   *   4. possibly more messages.by_message_id calls         [inside tryFallbackSummary]
   *   5. chats.by_chat_id (first) -> chat doc               [for todos update, optional]
   */
  function setupDbQueryChain(config: {
    assistantMessage: Record<string, any> | null;
    chatDoc: Record<string, any> | null;
    cutoffMessage: Record<string, any> | null;
    fallbackCutoffMessages?: (Record<string, any> | null)[];
  }): void {
    let callIndex = 0;
    const {
      assistantMessage,
      chatDoc,
      cutoffMessage,
      fallbackCutoffMessages = [],
    } = config;

    mockCtx.db.query.mockImplementation((table: string) => {
      const currentCall = callIndex++;

      if (currentCall === 0 && table === "messages") {
        return {
          withIndex: jest.fn().mockReturnValue({
            filter: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                first: jest.fn<any>().mockResolvedValue(assistantMessage),
              }),
            }),
          }),
        };
      }

      if (table === "chats") {
        return {
          withIndex: jest.fn().mockReturnValue({
            first: jest.fn<any>().mockResolvedValue(chatDoc),
          }),
        };
      }

      if (table === "messages") {
        const fallbackIdx = currentCall - 3;
        if (fallbackIdx >= 0 && fallbackIdx < fallbackCutoffMessages.length) {
          return {
            withIndex: jest.fn().mockReturnValue({
              first: jest
                .fn<any>()
                .mockResolvedValue(fallbackCutoffMessages[fallbackIdx]),
            }),
          };
        }
        return {
          withIndex: jest.fn().mockReturnValue({
            first: jest.fn<any>().mockResolvedValue(cutoffMessage),
          }),
        };
      }

      return {
        withIndex: jest.fn().mockReturnValue({
          first: jest.fn<any>().mockResolvedValue(null),
          filter: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              first: jest.fn<any>().mockResolvedValue(null),
            }),
          }),
        }),
      };
    });
  }

  it("should NOT invalidate when deleted message is newer than cutoff", async () => {
    const assistantMsg = makeAssistantMessage({ _creationTime: 5000 });
    const chatDoc = makeChatDoc();
    const cutoffMsg = {
      _id: "cutoff-doc",
      id: CUTOFF_MSG_ID,
      _creationTime: 3000,
    };
    const summaryDoc = makeSummaryDoc({ previous_summaries: [] });

    setupDbQueryChain({
      assistantMessage: assistantMsg,
      chatDoc,
      cutoffMessage: cutoffMsg,
    });
    mockCtx.db.get.mockResolvedValue(summaryDoc);

    const { deleteLastAssistantMessage } = await import("../messages");

    await deleteLastAssistantMessage.handler(mockCtx, { chatId: CHAT_ID });

    const summaryPatchCalls = mockCtx.db.patch.mock.calls.filter(
      (call: any[]) => call[0] === SUMMARY_DOC_ID,
    );
    expect(summaryPatchCalls).toHaveLength(0);

    const chatPatchCalls = mockCtx.db.patch.mock.calls.filter(
      (call: any[]) =>
        call[0] === CHAT_DOC_ID && call[1].latest_summary_id === undefined,
    );
    expect(chatPatchCalls).toHaveLength(0);
  });

  it("should fall back to first valid previous summary when current is invalid", async () => {
    const assistantMsg = makeAssistantMessage({ _creationTime: 2000 });
    const chatDoc = makeChatDoc();
    const summaryDoc = makeSummaryDoc({
      summary_up_to_message_id: "msg-cutoff",
      previous_summaries: [
        {
          summary_text: "fallback-text",
          summary_up_to_message_id: "msg-prev-1",
        },
      ],
    });

    const cutoffMsg = {
      _id: "cutoff-doc",
      id: "msg-cutoff",
      _creationTime: 3000,
    };
    const prevCutoffMsg = {
      _id: "prev-cutoff-doc",
      id: "msg-prev-1",
      _creationTime: 1000,
    };

    setupDbQueryChain({
      assistantMessage: assistantMsg,
      chatDoc,
      cutoffMessage: cutoffMsg,
      fallbackCutoffMessages: [prevCutoffMsg],
    });
    mockCtx.db.get.mockResolvedValue(summaryDoc);

    const { deleteLastAssistantMessage } = await import("../messages");

    await deleteLastAssistantMessage.handler(mockCtx, { chatId: CHAT_ID });

    expect(mockCtx.db.patch).toHaveBeenCalledWith(SUMMARY_DOC_ID, {
      summary_text: "fallback-text",
      summary_up_to_message_id: "msg-prev-1",
      previous_summaries: [],
    });
  });

  it("should skip invalid previous entries and promote a deeper valid one", async () => {
    const assistantMsg = makeAssistantMessage({ _creationTime: 2000 });
    const chatDoc = makeChatDoc();
    const summaryDoc = makeSummaryDoc({
      summary_up_to_message_id: "msg-cutoff",
      previous_summaries: [
        { summary_text: "prev-0-text", summary_up_to_message_id: "msg-prev-0" },
        { summary_text: "prev-1-text", summary_up_to_message_id: "msg-prev-1" },
      ],
    });

    const cutoffMsg = {
      _id: "cutoff-doc",
      id: "msg-cutoff",
      _creationTime: 3000,
    };
    const prev0CutoffMsg = {
      _id: "p0-doc",
      id: "msg-prev-0",
      _creationTime: 2500,
    };
    const prev1CutoffMsg = {
      _id: "p1-doc",
      id: "msg-prev-1",
      _creationTime: 500,
    };

    setupDbQueryChain({
      assistantMessage: assistantMsg,
      chatDoc,
      cutoffMessage: cutoffMsg,
      fallbackCutoffMessages: [prev0CutoffMsg, prev1CutoffMsg],
    });
    mockCtx.db.get.mockResolvedValue(summaryDoc);

    const { deleteLastAssistantMessage } = await import("../messages");

    await deleteLastAssistantMessage.handler(mockCtx, { chatId: CHAT_ID });

    expect(mockCtx.db.patch).toHaveBeenCalledWith(SUMMARY_DOC_ID, {
      summary_text: "prev-1-text",
      summary_up_to_message_id: "msg-prev-1",
      previous_summaries: [],
    });
  });

  it("should invalidate only the latest summary when message falls between previous and current cutoff", async () => {
    const assistantMsg = makeAssistantMessage({ _creationTime: 3000 });
    const chatDoc = makeChatDoc();
    const summaryDoc = makeSummaryDoc({
      summary_text: "second summary",
      summary_up_to_message_id: "msg-10",
      previous_summaries: [
        {
          summary_text: "first summary",
          summary_up_to_message_id: "msg-5",
        },
      ],
    });

    const cutoffMsg = {
      _id: "cutoff-doc-10",
      id: "msg-10",
      _creationTime: 5000,
    };
    const prevCutoffMsg = {
      _id: "cutoff-doc-5",
      id: "msg-5",
      _creationTime: 2000,
    };

    setupDbQueryChain({
      assistantMessage: assistantMsg,
      chatDoc,
      cutoffMessage: cutoffMsg,
      fallbackCutoffMessages: [prevCutoffMsg],
    });
    mockCtx.db.get.mockResolvedValue(summaryDoc);

    const { deleteLastAssistantMessage } = await import("../messages");

    await deleteLastAssistantMessage.handler(mockCtx, { chatId: CHAT_ID });

    expect(mockCtx.db.patch).toHaveBeenCalledWith(SUMMARY_DOC_ID, {
      summary_text: "first summary",
      summary_up_to_message_id: "msg-5",
      previous_summaries: [],
    });

    const deleteCalls = mockCtx.db.delete.mock.calls.filter(
      (call: any[]) => call[0] === SUMMARY_DOC_ID,
    );
    expect(deleteCalls).toHaveLength(0);

    const clearSummaryCalls = mockCtx.db.patch.mock.calls.filter(
      (call: any[]) =>
        call[0] === CHAT_DOC_ID && call[1].latest_summary_id === undefined,
    );
    expect(clearSummaryCalls).toHaveLength(0);
  });

  it("should fully delete summary when no valid fallback exists", async () => {
    const assistantMsg = makeAssistantMessage({ _creationTime: 2000 });
    const chatDoc = makeChatDoc();
    const summaryDoc = makeSummaryDoc({
      summary_up_to_message_id: "msg-cutoff",
      previous_summaries: [
        { summary_text: "prev-0-text", summary_up_to_message_id: "msg-prev-0" },
      ],
    });

    const cutoffMsg = {
      _id: "cutoff-doc",
      id: "msg-cutoff",
      _creationTime: 3000,
    };
    const prev0CutoffMsg = {
      _id: "p0-doc",
      id: "msg-prev-0",
      _creationTime: 2500,
    };

    setupDbQueryChain({
      assistantMessage: assistantMsg,
      chatDoc,
      cutoffMessage: cutoffMsg,
      fallbackCutoffMessages: [prev0CutoffMsg],
    });
    mockCtx.db.get.mockResolvedValue(summaryDoc);

    const { deleteLastAssistantMessage } = await import("../messages");

    await deleteLastAssistantMessage.handler(mockCtx, { chatId: CHAT_ID });

    expect(mockCtx.db.patch).toHaveBeenCalledWith(
      CHAT_DOC_ID,
      expect.objectContaining({ latest_summary_id: undefined }),
    );

    expect(mockCtx.db.delete).toHaveBeenCalledWith(SUMMARY_DOC_ID);
  });

  it("should delete summary when previous_summaries is undefined (legacy docs)", async () => {
    const assistantMsg = makeAssistantMessage({ _creationTime: 2000 });
    const chatDoc = makeChatDoc();
    const summaryDoc = makeSummaryDoc({
      summary_up_to_message_id: "msg-cutoff",
      previous_summaries: undefined,
    });

    const cutoffMsg = {
      _id: "cutoff-doc",
      id: "msg-cutoff",
      _creationTime: 3000,
    };

    setupDbQueryChain({
      assistantMessage: assistantMsg,
      chatDoc,
      cutoffMessage: cutoffMsg,
      fallbackCutoffMessages: [],
    });
    mockCtx.db.get.mockResolvedValue(summaryDoc);

    const { deleteLastAssistantMessage } = await import("../messages");

    await deleteLastAssistantMessage.handler(mockCtx, { chatId: CHAT_ID });

    expect(mockCtx.db.patch).toHaveBeenCalledWith(
      CHAT_DOC_ID,
      expect.objectContaining({ latest_summary_id: undefined }),
    );

    expect(mockCtx.db.delete).toHaveBeenCalledWith(SUMMARY_DOC_ID);
  });
});
