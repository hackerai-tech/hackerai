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
const { getUserChats } = require("../chats") as typeof import("../chats");

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
});
