import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
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
    chats: {},
    messages: {},
    redisPubsub: {},
    s3Cleanup: {},
  },
}));
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));
jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));
jest.mock("../lib/suspensionGuards", () => ({
  CHAT_ACCESS_SUSPENDED_CODE: "CHAT_ACCESS_SUSPENDED",
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
}));

const { ConvexError } =
  jest.requireMock<typeof import("convex/values")>("convex/values");
const { assertUserCanAccessChatHistory } = jest.requireMock<
  typeof import("../lib/suspensionGuards")
>("../lib/suspensionGuards");
const { getChatByIdFromClient, getUserChats } =
  require("../chats") as typeof import("../chats");

const emptyPage = {
  page: [],
  isDone: true,
  continueCursor: "",
};

describe("getUserChats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns an empty page when the user is unauthenticated", async () => {
    const ctx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue(null),
      },
      db: {
        query: jest.fn(),
      },
    };

    await expect(
      getUserChats.handler(ctx as any, {
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).resolves.toEqual(emptyPage);
    expect(assertUserCanAccessChatHistory).not.toHaveBeenCalled();
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  it("returns an empty page when chat history is suspended", async () => {
    jest.mocked(assertUserCanAccessChatHistory).mockRejectedValueOnce(
      new ConvexError({
        code: "CHAT_ACCESS_SUSPENDED",
        message: "Suspended",
      }),
    );

    const ctx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({
          subject: "user-123",
        }),
      },
      db: {
        query: jest.fn(),
      },
    };

    await expect(
      getUserChats.handler(ctx as any, {
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).resolves.toEqual(emptyPage);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  it("continues surfacing unexpected access guard errors", async () => {
    jest
      .mocked(assertUserCanAccessChatHistory)
      .mockRejectedValueOnce(new Error("unexpected"));

    const ctx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({
          subject: "user-123",
        }),
      },
      db: {
        query: jest.fn(),
      },
    };

    await expect(
      getUserChats.handler(ctx as any, {
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).rejects.toThrow("unexpected");
  });

  it("returns pinned project tasks in the global pinned results", async () => {
    const pinnedProjectTask = {
      _id: "pinned-doc",
      id: "pinned-task",
      title: "Pinned project task",
      user_id: "user-123",
      project_id: "project-1",
      pinned_at: 10,
      update_time: 10,
    };
    const regularTask = {
      _id: "regular-doc",
      id: "regular-task",
      title: "Regular task",
      user_id: "user-123",
      update_time: 9,
    };

    const pinnedTake = jest.fn<any>().mockResolvedValue([pinnedProjectTask]);
    const pinnedOrder = jest.fn<any>().mockReturnValue({ take: pinnedTake });
    const gt = jest.fn<any>().mockReturnThis();
    const pinnedEq = jest.fn<any>().mockReturnValue({ gt });
    const pinnedWithIndex = jest.fn<any>((indexName, applyIndex) => {
      expect(indexName).toBe("by_user_and_pinned");
      applyIndex({ eq: pinnedEq });
      return { order: pinnedOrder };
    });

    const page = {
      page: [regularTask],
      isDone: true,
      continueCursor: "",
    };
    const paginate = jest.fn<any>().mockResolvedValue(page);
    const regularOrder = jest.fn<any>().mockReturnValue({ paginate });
    const regularEq = jest.fn<any>().mockReturnThis();
    const regularWithIndex = jest.fn<any>((indexName, applyIndex) => {
      expect(indexName).toBe("by_user_project_and_updated");
      applyIndex({ eq: regularEq });
      return { order: regularOrder };
    });
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "user-123" }),
      },
      db: {
        query: jest
          .fn<any>()
          .mockReturnValueOnce({ withIndex: pinnedWithIndex })
          .mockReturnValueOnce({ withIndex: regularWithIndex }),
      },
    };

    await expect(
      getUserChats.handler(ctx as any, {
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).resolves.toEqual({
      ...page,
      page: [pinnedProjectTask, regularTask],
    });
    expect(pinnedEq).toHaveBeenCalledWith("user_id", "user-123");
    expect(gt).toHaveBeenCalledWith("pinned_at", 0);
    expect(regularEq).toHaveBeenCalledWith("user_id", "user-123");
    expect(regularEq).toHaveBeenCalledWith("project_id", undefined);
  });

  it("uses a safe legacy fork title after another user's share is revoked", async () => {
    const legacyFork = {
      _id: "fork-doc",
      id: "fork-1",
      title: "My legacy fork",
      user_id: "user-123",
      branched_from_chat_id: "source-1",
      update_time: 1,
    };
    const page = {
      page: [legacyFork],
      isDone: true,
      continueCursor: "",
    };
    const paginate = jest.fn<any>().mockResolvedValue(page);
    const regularOrder = jest.fn<any>().mockReturnValue({ paginate });
    const regularWithIndex = jest.fn<any>().mockReturnValue({
      order: regularOrder,
    });
    const sourceFirst = jest.fn<any>().mockResolvedValue({
      _id: "source-doc",
      id: "source-1",
      title: "Private renamed source",
      user_id: "source-owner",
      update_time: 2,
    });
    const sourceWithIndex = jest.fn<any>().mockReturnValue({
      first: sourceFirst,
    });
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "user-123" }),
      },
      db: {
        query: jest
          .fn<any>()
          .mockReturnValueOnce({ withIndex: regularWithIndex })
          .mockReturnValueOnce({ withIndex: sourceWithIndex }),
      },
    };

    await expect(
      getUserChats.handler(ctx as any, {
        paginationOpts: { numItems: 20, cursor: "next-page" },
      }),
    ).resolves.toEqual({
      ...page,
      page: [
        expect.objectContaining({
          branched_from_title: "My legacy fork",
        }),
      ],
    });
  });

  it("uses the fork-time title in the single-chat query after revocation", async () => {
    const fork = {
      _id: "fork-doc",
      _creationTime: 1,
      id: "fork-1",
      title: "My fork",
      user_id: "user-123",
      branched_from_chat_id: "source-1",
      branched_from_title: "Title when forked",
      update_time: 1,
    };
    const source = {
      _id: "source-doc",
      _creationTime: 1,
      id: "source-1",
      title: "Private renamed source",
      user_id: "source-owner",
      update_time: 2,
    };
    const first = jest
      .fn<any>()
      .mockResolvedValueOnce(fork)
      .mockResolvedValueOnce(source);
    const withIndex = jest.fn<any>().mockReturnValue({ first });
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "user-123" }),
      },
      db: {
        query: jest.fn<any>().mockReturnValue({ withIndex }),
      },
    };

    await expect(
      getChatByIdFromClient.handler(ctx as any, { id: "fork-1" }),
    ).resolves.toEqual(
      expect.objectContaining({
        branched_from_title: "Title when forked",
      }),
    );
  });
});
