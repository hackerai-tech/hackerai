import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: unknown) => config),
  query: jest.fn((config: unknown) => config),
  internalQuery: jest.fn((config: unknown) => config),
}));
jest.mock("convex/values", () => {
  const actualValues =
    jest.requireActual<typeof import("convex/values")>("convex/values");

  return {
    v: {
      any: jest.fn(() => "any"),
      array: jest.fn(() => "array"),
      boolean: jest.fn(() => "boolean"),
      id: jest.fn(() => "id"),
      literal: jest.fn(() => "literal"),
      null: jest.fn(() => "null"),
      number: jest.fn(() => "number"),
      object: jest.fn(() => "object"),
      optional: jest.fn(() => "optional"),
      string: jest.fn(() => "string"),
      union: jest.fn(() => "union"),
    },
    ConvexError: class ConvexError extends Error {},
    getDocumentSize: actualValues.getDocumentSize,
  };
});
jest.mock("../_generated/api", () => ({ internal: {} }));
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: { deleteIfExists: jest.fn() },
}));
jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));
jest.mock("../lib/sharedChatSnapshot", () => ({
  getVisibleSharedChatByShareId: jest.fn(),
  listVisibleSharedMessages: jest.fn(),
  sharedMessageValidator: "sharedMessageValidator",
}));

const { getVisibleSharedChatByShareId, listVisibleSharedMessages } =
  jest.requireMock("../lib/sharedChatSnapshot") as {
    getVisibleSharedChatByShareId: jest.Mock;
    listVisibleSharedMessages: jest.Mock;
  };

describe("getSharedMessages", () => {
  it("authorizes the read with the active share ID", async () => {
    const sharedChat = {
      id: "chat-1",
      share_id: "new-share-id",
      share_date: 200,
    };
    const messages = [{ id: "message-1" }];
    getVisibleSharedChatByShareId.mockResolvedValue(sharedChat);
    listVisibleSharedMessages.mockResolvedValue(messages);

    const { getSharedMessages } = await import("../messages");
    const ctx = { db: {} };

    await expect(
      getSharedMessages.handler(ctx as any, { shareId: "new-share-id" }),
    ).resolves.toEqual(messages);

    expect(getVisibleSharedChatByShareId).toHaveBeenCalledWith(
      ctx,
      "new-share-id",
    );
    expect(listVisibleSharedMessages).toHaveBeenCalledWith(ctx, sharedChat);
  });

  it("returns no messages when the supplied share ID is no longer active", async () => {
    getVisibleSharedChatByShareId.mockResolvedValue(null);

    const { getSharedMessages } = await import("../messages");
    const ctx = { db: {} };

    await expect(
      getSharedMessages.handler(ctx as any, { shareId: "revoked-share-id" }),
    ).resolves.toEqual([]);

    expect(listVisibleSharedMessages).not.toHaveBeenCalled();
  });
});
