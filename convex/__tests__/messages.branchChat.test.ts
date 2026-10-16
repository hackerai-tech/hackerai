import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getDocumentSize } from "convex/values";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  internalQuery: (config: unknown) => config,
}));
jest.mock("../_generated/api", () => ({
  internal: { messages: { verifyChatOwnership: "verifyChatOwnership" } },
}));
jest.mock("../fileAggregate", () => ({ fileCountAggregate: {} }));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.mock("../lib/logger", () => ({
  convexLogger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const { assertUserCanAccessChatHistory } = jest.requireMock(
  "../lib/suspensionGuards",
) as { assertUserCanAccessChatHistory: jest.Mock<any> };
const { convexLogger } = jest.requireMock("../lib/logger") as {
  convexLogger: { warn: jest.Mock };
};

const MB = 1024 * 1024;
const makeMessage = (index: number, text = `message ${index}`) => ({
  _id: `doc-${index}`,
  _creationTime: index,
  id: `message-${index}`,
  chat_id: "source-chat",
  user_id: "owner",
  role: index % 2 ? "assistant" : "user",
  parts: [{ type: "text", text }],
  content: text,
  update_time: index,
});

function makeContext(messages: ReturnType<typeof makeMessage>[]) {
  const anchor = messages.at(-1)!;
  const originalChat = {
    _id: "source-chat-doc",
    id: "source-chat",
    title: "Task title",
    user_id: "owner",
    project_id: "project-1",
    latest_summary_id: "summary-doc",
  };
  let readBytes = 0;
  let readRows = 0;
  const history = {
    withIndex: jest.fn<any>().mockReturnThis(),
    order: jest.fn<any>().mockReturnThis(),
    // Model the platform stopping at the byte/row budget, including a final
    // document that can cross the byte boundary. Never scan the remaining rows.
    paginate: jest.fn<any>().mockImplementation(async (opts: any) => {
      const page = [];
      for (const msg of messages) {
        if (
          page.length >= opts.numItems ||
          readRows >= opts.maximumRowsRead ||
          readBytes >= opts.maximumBytesRead
        )
          break;
        readBytes += getDocumentSize(msg);
        readRows++;
        page.push(msg);
      }
      return {
        page,
        isDone: page.length === messages.length,
        continueCursor: "remaining-history",
      };
    }),
  };
  const anchorQuery = {
    withIndex: jest.fn<any>().mockReturnThis(),
    first: jest.fn<any>().mockResolvedValue(anchor),
  };
  const chatQuery = {
    withIndex: jest.fn<any>().mockReturnThis(),
    first: jest.fn<any>().mockResolvedValue(originalChat),
  };
  let messageQueries = 0;
  const db = {
    query: jest
      .fn<any>()
      .mockImplementation((table: string) =>
        table === "messages"
          ? messageQueries++ === 0
            ? anchorQuery
            : history
          : chatQuery,
      ),
    insert: jest
      .fn<any>()
      .mockImplementation(async (table: string) =>
        table === "chats" ? "new-chat-doc" : `${table}-new-doc`,
      ),
    get: jest.fn<any>().mockResolvedValue({
      _id: "summary-doc",
      chat_id: "source-chat",
      summary_text: "Summary",
      summary_up_to_message_id: messages[0].id,
      previous_summaries: [],
    }),
    patch: jest.fn<any>().mockResolvedValue(undefined),
  };
  return {
    ctx: {
      db,
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({ subject: "owner" }),
      },
      runQuery: jest.fn<any>().mockResolvedValue(true),
    },
    anchor,
    anchorQuery,
    originalChat,
    history,
    readBudget: () => ({ bytes: readBytes, rows: readRows }),
  };
}

async function branch(fixture: ReturnType<typeof makeContext>) {
  const { branchChat } = await import("../messages");
  return branchChat.handler(fixture.ctx as any, {
    messageId: fixture.anchor.id,
  });
}

describe("atomic chat branching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUserCanAccessChatHistory.mockResolvedValue(undefined);
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rejects a history exceeding 16MiB after a bounded read, before creating anything", async () => {
    const f = makeContext(
      Array.from({ length: 40 }, (_, i) =>
        makeMessage(i, "private-canary".repeat(30_000)),
      ),
    );
    expect(f.anchor.parts[0].text.length * 2 * 40).toBeGreaterThan(16 * MB);
    await expect(branch(f)).rejects.toMatchObject({
      data: { code: "BRANCH_HISTORY_TOO_LARGE" },
    });
    expect(f.readBudget().bytes).toBeLessThan(5 * MB);
    expect(f.readBudget().rows).toBeLessThan(40);
    expect(f.history.paginate).toHaveBeenCalledTimes(1);
    expect(f.ctx.db.insert).not.toHaveBeenCalled();
    expect(f.ctx.db.get).not.toHaveBeenCalled();
    expect(JSON.stringify(convexLogger.warn.mock.calls)).not.toContain(
      "private-canary",
    );
  });

  it("does not accept an oversized last document even when the range is complete", async () => {
    const f = makeContext(
      Array.from({ length: 5 }, (_, i) => makeMessage(i, "x".repeat(450_000))),
    );
    await expect(branch(f)).rejects.toMatchObject({
      data: { code: "BRANCH_HISTORY_TOO_LARGE" },
    });
    expect(f.readBudget().rows).toBe(5);
    expect(f.ctx.db.insert).not.toHaveBeenCalled();
  });

  it("bounds tiny-message histories by count rather than copying a prefix", async () => {
    const f = makeContext(
      Array.from({ length: 1200 }, (_, i) => makeMessage(i)),
    );
    await expect(branch(f)).rejects.toMatchObject({
      data: { code: "BRANCH_HISTORY_TOO_LARGE" },
    });
    expect(f.readBudget().rows).toBe(1000);
    expect(f.ctx.db.insert).not.toHaveBeenCalled();
  });

  it("rejects a required split even if a contradictory completion flag is present", async () => {
    const f = makeContext([makeMessage(0)]);
    f.history.paginate.mockResolvedValue({
      page: [],
      isDone: true,
      pageStatus: "SplitRequired",
    });
    await expect(branch(f)).rejects.toMatchObject({
      data: { code: "BRANCH_HISTORY_TOO_LARGE" },
    });
    expect(f.ctx.db.insert).not.toHaveBeenCalled();
  });

  it("preserves private takeover context when branching without making it visible", async () => {
    const f = makeContext([
      makeMessage(0),
      {
        ...makeMessage(1, "Private takeover note"),
        is_hidden: true,
        is_browser_handoff: true,
      } as ReturnType<typeof makeMessage>,
      makeMessage(2),
    ]);
    await branch(f);
    const note = f.ctx.db.insert.mock.calls.find(
      ([table, doc]) =>
        table === "messages" && doc.source_message_id === "message-1",
    )?.[1];
    expect(note).toMatchObject({
      content: "Private takeover note",
      is_hidden: true,
      is_browser_handoff: true,
    });
  });

  it("copies a complete large-message history and remaps its summary atomically", async () => {
    const messages = [
      makeMessage(0, "a".repeat(450_000)),
      makeMessage(1, "b".repeat(450_000)),
    ];
    const f = makeContext(messages);
    const id = await branch(f);
    expect(id).toEqual(expect.any(String));
    const copies = f.ctx.db.insert.mock.calls
      .filter(([table]) => table === "messages")
      .map(([, doc]) => doc);
    expect(copies).toHaveLength(2);
    copies.forEach((doc, i) => {
      expect(doc).toMatchObject({
        chat_id: id,
        user_id: "owner",
        parts: messages[i].parts,
        content: messages[i].content,
        source_message_id: messages[i].id,
      });
      expect(doc.id).not.toBe(messages[i].id);
    });
    expect(f.ctx.db.insert).toHaveBeenCalledWith(
      "chats",
      expect.objectContaining({
        id,
        title: "Task title",
        project_id: "project-1",
      }),
    );
    expect(f.ctx.db.insert).toHaveBeenCalledWith(
      "chat_summaries",
      expect.objectContaining({
        chat_id: id,
        summary_up_to_message_id: copies[0].id,
      }),
    );
    expect(f.ctx.db.patch).toHaveBeenCalledWith("new-chat-doc", {
      latest_summary_id: "chat_summaries-new-doc",
    });
    expect(convexLogger.warn).not.toHaveBeenCalled();
    expect(f.history.withIndex).toHaveBeenCalledWith(
      "by_chat_id",
      expect.any(Function),
    );
    const index: any = {
      eq: jest.fn<any>().mockReturnThis(),
      lte: jest.fn<any>().mockReturnThis(),
    };
    f.history.withIndex.mock.calls[0][1](index);
    expect(index.eq).toHaveBeenCalledWith("chat_id", "source-chat");
    expect(index.lte).toHaveBeenCalledWith(
      "_creationTime",
      f.anchor._creationTime,
    );
  });

  it("allows a complete 1000-message range without reading another page", async () => {
    const f = makeContext(
      Array.from({ length: 1000 }, (_, i) => makeMessage(i)),
    );
    await branch(f);
    expect(
      f.ctx.db.insert.mock.calls.filter(([table]) => table === "messages"),
    ).toHaveLength(1000);
    expect(f.history.paginate).toHaveBeenCalledTimes(1);
  });

  it("keeps the complete copy plus a near-limit summary within the transaction write budget", async () => {
    const f = makeContext(
      Array.from({ length: 4 }, (_, i) => makeMessage(i, "x".repeat(450_000))),
    );
    f.ctx.db.get.mockResolvedValue({
      chat_id: "source-chat",
      summary_text: "s".repeat(900_000),
      summary_up_to_message_id: f.anchor.id,
      previous_summaries: [],
    });
    await branch(f);
    const insertedBytes = f.ctx.db.insert.mock.calls.reduce(
      (sum, [, doc]) => sum + getDocumentSize(JSON.parse(JSON.stringify(doc))),
      0,
    );
    expect(insertedBytes).toBeLessThan(6 * MB);
    expect(
      f.ctx.db.insert.mock.calls.filter(([table]) => table === "messages"),
    ).toHaveLength(4);
    expect(
      f.ctx.db.insert.mock.calls.filter(
        ([table]) => table === "chat_summaries",
      ),
    ).toHaveLength(1);
  });

  it("does not treat an empty incomplete page as a successful empty branch", async () => {
    const f = makeContext([makeMessage(0)]);
    f.history.paginate.mockResolvedValue({ page: [], isDone: false });
    await expect(branch(f)).rejects.toMatchObject({
      data: { code: "BRANCH_HISTORY_TOO_LARGE" },
    });
    expect(f.ctx.db.insert).not.toHaveBeenCalled();
  });

  it.each(["message", "chat"])(
    "checks %s ownership before loading history",
    async (kind) => {
      const f = makeContext([makeMessage(0)]);
      if (kind === "message")
        f.anchorQuery.first.mockResolvedValue({
          ...f.anchor,
          user_id: "another-user",
        });
      else f.ctx.runQuery.mockResolvedValue(false);
      await expect(branch(f)).resolves.toBeNull();
      expect(f.history.paginate).not.toHaveBeenCalled();
      expect(f.ctx.db.insert).not.toHaveBeenCalled();
    },
  );

  it("retains suspension and authentication gates before database access", async () => {
    const f = makeContext([makeMessage(0)]);
    assertUserCanAccessChatHistory.mockRejectedValue(new Error("blocked"));
    await expect(branch(f)).rejects.toThrow("blocked");
    expect(f.ctx.db.query).not.toHaveBeenCalled();
    f.ctx.auth.getUserIdentity.mockResolvedValue(null);
    await expect(branch(f)).rejects.toThrow("Unauthorized");
    expect(f.ctx.db.query).not.toHaveBeenCalled();
  });
});
