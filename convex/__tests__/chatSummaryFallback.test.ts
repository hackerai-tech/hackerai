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

describe("copyChatSummary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("remaps cutoff IDs without copying source cutoff creation time", async () => {
    const { copyChatSummary } = await import("../lib/utils");
    const mockDb = {
      get: jest.fn<any>().mockResolvedValue(
        makeSummaryDoc({
          summary_up_to_message_id: "source-msg",
          summary_up_to_message_creation_time: 12345,
          reason: "token_threshold",
          prompt_version: "test-prompt-v1",
        }),
      ),
      insert: jest.fn<any>().mockResolvedValue("new-summary-id"),
      patch: jest.fn<any>().mockResolvedValue(undefined),
    };

    await copyChatSummary(mockDb as any, {
      sourceSummaryId: SUMMARY_DOC_ID,
      targetChatDocId: "target-chat-doc-id" as Id<"chats">,
      targetChatId: "target-chat-id",
      messageIdMap: new Map([["source-msg", "target-msg"]]),
    });

    expect(mockDb.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.not.objectContaining({
        summary_up_to_message_creation_time: 12345,
      }),
    );
    expect(mockDb.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.objectContaining({
        summary_up_to_message_id: "target-msg",
        reason: "token_threshold",
        prompt_version: "test-prompt-v1",
      }),
    );
  });
});

describe("saveLatestSummary — previous_summaries chain", () => {
  let mockCtx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
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

  function setupSaveSummaryQueries(
    chat: Record<string, any> | null,
    opts: {
      incomingCutoffCreationTime?: number | null;
      previousCutoffCreationTime?: number | null;
    } = {},
  ): void {
    const {
      incomingCutoffCreationTime = 10_000,
      previousCutoffCreationTime = 5_000,
    } = opts;
    let messageQueryCount = 0;

    mockCtx.db.query.mockImplementation((table: string) => {
      if (table === "chats") {
        return {
          withIndex: jest.fn().mockReturnValue({
            first: jest.fn<any>().mockResolvedValue(chat),
          }),
        };
      }

      if (table === "messages") {
        const creationTime =
          messageQueryCount++ === 0
            ? incomingCutoffCreationTime
            : previousCutoffCreationTime;
        return {
          withIndex: jest.fn().mockReturnValue({
            first: jest
              .fn<any>()
              .mockResolvedValue(
                creationTime === null ? null : { _creationTime: creationTime },
              ),
          }),
        };
      }

      return {
        withIndex: jest.fn().mockReturnValue({
          first: jest.fn<any>().mockResolvedValue(null),
        }),
      };
    });
  }

  it("should set previous_summaries to [] when no existing summary", async () => {
    const chat = makeChatDoc({ latest_summary_id: undefined });
    setupSaveSummaryQueries(chat);

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "new summary",
      summaryUpToMessageId: "msg-10",
      metadata: {
        reason: "token_threshold",
        promptVersion: "test-prompt-v1",
        model: "test-model",
        status: "completed",
        inputTokens: 100,
        outputTokens: 20,
        estimatedCompactedInputTokens: 90,
        transcriptPath: "/tmp/agent-transcripts/test.json",
      },
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.objectContaining({
        previous_summaries: [],
        summary_up_to_message_creation_time: 10_000,
        reason: "token_threshold",
        prompt_version: "test-prompt-v1",
        model: "test-model",
        status: "completed",
        input_tokens: 100,
        output_tokens: 20,
        estimated_compacted_input_tokens: 90,
        transcript_path: "/tmp/agent-transcripts/test.json",
      }),
    );
  });

  it("should push old summary into previous_summaries[0] on second save", async () => {
    const chat = makeChatDoc();
    setupSaveSummaryQueries(chat);

    const oldSummary = makeSummaryDoc({
      summary_text: "old text",
      summary_up_to_message_id: "msg-5",
      summary_up_to_message_creation_time: 5_000,
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
          {
            summary_text: "old text",
            summary_up_to_message_id: "msg-5",
            summary_up_to_message_creation_time: 5_000,
          },
        ],
      }),
    );
    expect(mockCtx.db.delete).not.toHaveBeenCalledWith(SUMMARY_DOC_ID);
  });

  it("should preserve the chain: [old, ...old_previous_summaries]", async () => {
    const chat = makeChatDoc();
    setupSaveSummaryQueries(chat);

    const existingChain = [
      { summary_text: "even-older", summary_up_to_message_id: "msg-1" },
    ];
    const oldSummary = makeSummaryDoc({
      summary_text: "old text",
      summary_up_to_message_id: "msg-5",
      summary_up_to_message_creation_time: 5_000,
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
          {
            summary_text: "old text",
            summary_up_to_message_id: "msg-5",
            summary_up_to_message_creation_time: 5_000,
          },
          { summary_text: "even-older", summary_up_to_message_id: "msg-1" },
        ],
      }),
    );
  });

  it("should truncate previous_summaries at MAX_PREVIOUS_SUMMARIES (10)", async () => {
    const chat = makeChatDoc();
    setupSaveSummaryQueries(chat);

    const existingChain = Array.from({ length: 11 }, (_, i) => ({
      summary_text: `prev-${i}`,
      summary_up_to_message_id: `msg-prev-${i}`,
    }));
    const oldSummary = makeSummaryDoc({
      summary_text: "old text",
      summary_up_to_message_id: "msg-5",
      summary_up_to_message_creation_time: 5_000,
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
      summary_up_to_message_creation_time: 5_000,
    });
  });

  it("should skip stale saves when an existing summary has a newer cutoff", async () => {
    const chat = makeChatDoc();
    setupSaveSummaryQueries(chat, { incomingCutoffCreationTime: 5_000 });

    const oldSummary = makeSummaryDoc({
      summary_text: "newer summary",
      summary_up_to_message_id: "msg-10",
      summary_up_to_message_creation_time: 10_000,
    });
    mockCtx.db.get.mockResolvedValue(oldSummary);

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "stale summary",
      summaryUpToMessageId: "msg-5",
    });

    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
  });

  it("should save a different cutoff message with the same creation time", async () => {
    const chat = makeChatDoc();
    setupSaveSummaryQueries(chat, { incomingCutoffCreationTime: 10_000 });

    const oldSummary = makeSummaryDoc({
      summary_text: "same-ms summary",
      summary_up_to_message_id: "msg-10",
      summary_up_to_message_creation_time: 10_000,
    });
    mockCtx.db.get.mockResolvedValue(oldSummary);

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "new same-ms summary",
      summaryUpToMessageId: "msg-11",
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.objectContaining({
        summary_up_to_message_id: "msg-11",
        summary_up_to_message_creation_time: 10_000,
      }),
    );
    expect(mockCtx.db.patch).toHaveBeenCalledWith(CHAT_DOC_ID, {
      latest_summary_id: "new-summary-id",
    });
  });

  it("should skip saves when the incoming cutoff message was deleted", async () => {
    const chat = makeChatDoc({ latest_summary_id: undefined });
    setupSaveSummaryQueries(chat, { incomingCutoffCreationTime: null });

    const { saveLatestSummary } = await import("../chats");

    await saveLatestSummary.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      summaryText: "orphaned summary",
      summaryUpToMessageId: "deleted-msg",
    });

    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
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
        // deleteLastAssistantMessage now fetches all messages desc to walk back the chain
        const allMessages = assistantMessage ? [assistantMessage] : [];
        return {
          withIndex: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              collect: jest.fn<any>().mockResolvedValue(allMessages),
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

  it("should delete feedback before deleting regenerated assistant messages", async () => {
    const assistantMsg = makeAssistantMessage({
      _creationTime: 5000,
      feedback_id: "feedback-1" as Id<"feedback">,
    });
    const chatDoc = makeChatDoc({ latest_summary_id: undefined });

    setupDbQueryChain({
      assistantMessage: assistantMsg,
      chatDoc,
      cutoffMessage: null,
    });

    const { deleteLastAssistantMessage } = await import("../messages");

    await deleteLastAssistantMessage.handler(mockCtx, { chatId: CHAT_ID });

    const deleteArgs = mockCtx.db.delete.mock.calls.map(
      (call: any[]) => call[0],
    );
    expect(deleteArgs).toContain("feedback-1");
    expect(deleteArgs).toContain(ASSISTANT_MSG_ID);
    expect(deleteArgs.indexOf("feedback-1")).toBeLessThan(
      deleteArgs.indexOf(ASSISTANT_MSG_ID),
    );
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

describe("regenerateWithNewContent feedback cleanup", () => {
  let mockCtx: any;

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

  it("should delete feedback for later messages removed by edit-regenerate", async () => {
    const editedUserMessage = {
      _id: "user-doc-1" as Id<"messages">,
      id: "user-msg-1",
      chat_id: CHAT_ID,
      user_id: USER_ID,
      role: "user",
      parts: [{ type: "text", text: "old prompt" }],
      content: "old prompt",
      _creationTime: 1000,
      file_ids: undefined,
    };
    const laterAssistantMessage = {
      _id: "asst-doc-1" as Id<"messages">,
      id: "asst-msg-1",
      chat_id: CHAT_ID,
      user_id: USER_ID,
      role: "assistant",
      parts: [{ type: "text", text: "old response" }],
      _creationTime: 2000,
      file_ids: undefined,
      feedback_id: "feedback-2" as Id<"feedback">,
    };
    const chatDoc = makeChatDoc({ latest_summary_id: undefined });

    mockCtx.db.query.mockImplementation((table: string) => {
      if (table === "messages") {
        return {
          withIndex: jest.fn((indexName: string) => {
            if (indexName === "by_message_id") {
              return {
                first: jest.fn<any>().mockResolvedValue(editedUserMessage),
              };
            }
            if (indexName === "by_chat_id") {
              return {
                collect: jest
                  .fn<any>()
                  .mockResolvedValue([laterAssistantMessage]),
              };
            }
            throw new Error(`Unexpected messages index ${indexName}`);
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

      throw new Error(`Unexpected table ${table}`);
    });

    const { regenerateWithNewContent } = await import("../messages");

    await regenerateWithNewContent.handler(mockCtx, {
      messageId: editedUserMessage.id,
      newContent: "new prompt",
    });

    const deleteArgs = mockCtx.db.delete.mock.calls.map(
      (call: any[]) => call[0],
    );
    expect(deleteArgs).toContain("feedback-2");
    expect(deleteArgs).toContain(laterAssistantMessage._id);
    expect(deleteArgs.indexOf("feedback-2")).toBeLessThan(
      deleteArgs.indexOf(laterAssistantMessage._id),
    );
  });
});
