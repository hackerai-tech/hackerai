import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: unknown) => config),
  query: jest.fn((config: unknown) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    array: jest.fn(() => "array"),
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
    number: jest.fn(() => "number"),
    object: jest.fn(() => "object"),
    string: jest.fn(() => "string"),
    union: jest.fn(() => "union"),
  },
}));
jest.mock("../lib/logger", () => ({
  convexLogger: {
    warn: jest.fn(),
  },
}));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
  isUserBlockedByActiveFraudDispute: jest.fn<any>().mockResolvedValue(false),
}));

const { forkSharedChat } =
  require("../sharedChats") as typeof import("../sharedChats");

describe("forkSharedChat", () => {
  it("stores the source title snapshot on the new owned fork", async () => {
    const sourceChat = {
      _id: "source-doc",
      id: "source-1",
      title: "Shared title",
      user_id: "source-owner",
      share_id: "11111111-1111-4111-8111-111111111111",
      share_date: 100,
      update_time: 100,
    };
    const sourceFirst = jest.fn<any>().mockResolvedValue(sourceChat);
    const messagesCollect = jest.fn<any>().mockResolvedValue([]);
    const insert = jest.fn<any>().mockResolvedValue("fork-doc");
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "fork-owner" }),
      },
      db: {
        query: jest.fn<any>((table: string) => ({
          withIndex: jest.fn<any>().mockReturnValue(
            table === "chats"
              ? { first: sourceFirst }
              : {
                  order: jest.fn<any>().mockReturnValue({
                    collect: messagesCollect,
                  }),
                },
          ),
        })),
        insert,
      },
    };

    await expect(
      forkSharedChat.handler(ctx as any, {
        shareId: sourceChat.share_id,
      }),
    ).resolves.toEqual(expect.any(String));

    expect(insert).toHaveBeenCalledWith(
      "chats",
      expect.objectContaining({
        title: "Shared title",
        user_id: "fork-owner",
        branched_from_chat_id: "source-1",
        branched_from_title: "Shared title",
      }),
    );
  });
});
