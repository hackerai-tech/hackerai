import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: unknown) => config),
  query: jest.fn((config: unknown) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    array: jest.fn(() => "array"),
    any: jest.fn(() => "any"),
    id: jest.fn(() => "id"),
    literal: jest.fn(() => "literal"),
    null: jest.fn(() => "null"),
    number: jest.fn(() => "number"),
    object: jest.fn(() => "object"),
    optional: jest.fn(() => "optional"),
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
  isUserBlockedFromChatHistory: jest.fn<any>().mockResolvedValue(false),
}));

const { forkSharedChat, getSharedSnapshot } =
  require("../sharedChats") as typeof import("../sharedChats");

describe("getSharedSnapshot", () => {
  it("returns frozen, anonymous chat data with one shared-chat lookup", async () => {
    const sharedChat = {
      _id: "source-doc",
      _creationTime: 1,
      id: "source-1",
      title: "Shared title",
      user_id: "source-owner",
      share_id: "11111111-1111-4111-8111-111111111111",
      share_date: 200,
      update_time: 200,
    };
    const chatFirst = jest.fn<any>().mockResolvedValue(sharedChat);
    const messagesCollect = jest.fn<any>().mockResolvedValue([
      {
        _id: "message-2",
        _creationTime: 20,
        id: "visible-file",
        chat_id: sharedChat.id,
        user_id: sharedChat.user_id,
        role: "assistant",
        content: "download",
        parts: [
          {
            type: "file",
            name: "private.txt",
            mediaType: "text/plain",
            url: "https://secret.example/private.txt",
          },
        ],
        update_time: 150,
      },
      {
        _id: "message-1",
        _creationTime: 10,
        id: "visible-text",
        chat_id: sharedChat.id,
        user_id: sharedChat.user_id,
        role: "user",
        content: "hello",
        parts: [{ type: "text", text: "hello" }],
        update_time: 100,
      },
      {
        _id: "message-3",
        _creationTime: 30,
        id: "hidden",
        chat_id: sharedChat.id,
        user_id: sharedChat.user_id,
        role: "assistant",
        parts: [{ type: "text", text: "hidden" }],
        is_hidden: true,
        update_time: 175,
      },
      {
        _id: "message-4",
        _creationTime: 40,
        id: "after-share",
        chat_id: sharedChat.id,
        user_id: sharedChat.user_id,
        role: "assistant",
        parts: [{ type: "text", text: "new" }],
        update_time: 250,
      },
    ]);
    const query = jest.fn<any>((table: string) => ({
      withIndex: jest.fn<any>().mockReturnValue(
        table === "chats"
          ? { first: chatFirst }
          : {
              order: jest.fn<any>().mockReturnValue({
                collect: messagesCollect,
              }),
            },
      ),
    }));

    await expect(
      getSharedSnapshot.handler({ db: { query } } as any, {
        shareId: sharedChat.share_id,
      }),
    ).resolves.toEqual({
      chat: {
        _id: sharedChat._id,
        id: sharedChat.id,
        title: sharedChat.title,
        share_id: sharedChat.share_id,
        share_date: sharedChat.share_date,
        update_time: sharedChat.update_time,
      },
      messages: [
        {
          id: "visible-text",
          role: "user",
          content: "hello",
          parts: [{ type: "text", text: "hello" }],
          update_time: 100,
        },
        {
          id: "visible-file",
          role: "assistant",
          content: "download",
          parts: [{ type: "file", placeholder: true }],
          update_time: 150,
        },
      ],
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, "chats");
    expect(query).toHaveBeenNthCalledWith(2, "messages");
    expect(chatFirst).toHaveBeenCalledTimes(1);
  });

  it("returns null without reading messages when the share is unavailable", async () => {
    const query = jest.fn<any>(() => ({
      withIndex: jest.fn<any>().mockReturnValue({
        first: jest.fn<any>().mockResolvedValue(null),
      }),
    }));

    await expect(
      getSharedSnapshot.handler({ db: { query } } as any, {
        shareId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("chats");
  });

  it("returns null without reading messages when the chat owner is blocked", async () => {
    const { isUserBlockedFromChatHistory } = jest.requireMock(
      "../lib/suspensionGuards",
    ) as { isUserBlockedFromChatHistory: jest.Mock };
    isUserBlockedFromChatHistory.mockResolvedValueOnce(true);

    const sharedChat = {
      _id: "source-doc",
      _creationTime: 1,
      id: "source-1",
      title: "Shared title",
      user_id: "blocked-owner",
      share_id: "11111111-1111-4111-8111-111111111111",
      share_date: 200,
      update_time: 200,
    };
    const query = jest.fn<any>(() => ({
      withIndex: jest.fn<any>().mockReturnValue({
        first: jest.fn<any>().mockResolvedValue(sharedChat),
      }),
    }));
    const ctx = { db: { query } };

    await expect(
      getSharedSnapshot.handler(ctx as any, {
        shareId: sharedChat.share_id,
      }),
    ).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("chats");
    expect(isUserBlockedFromChatHistory).toHaveBeenCalledWith(
      ctx,
      sharedChat.user_id,
    );
  });

  it("preserves chat metadata when the message read fails", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const sharedChat = {
      _id: "source-doc",
      _creationTime: 1,
      id: "source-1",
      title: "Shared title",
      user_id: "source-owner",
      share_id: "11111111-1111-4111-8111-111111111111",
      share_date: 200,
      update_time: 200,
    };
    const query = jest.fn<any>((table: string) => ({
      withIndex: jest.fn<any>().mockReturnValue(
        table === "chats"
          ? { first: jest.fn<any>().mockResolvedValue(sharedChat) }
          : {
              order: jest.fn<any>().mockReturnValue({
                collect: jest
                  .fn<any>()
                  .mockRejectedValue(new Error("messages unavailable")),
              }),
            },
      ),
    }));

    await expect(
      getSharedSnapshot.handler({ db: { query } } as any, {
        shareId: sharedChat.share_id,
      }),
    ).resolves.toEqual({
      chat: {
        _id: sharedChat._id,
        id: sharedChat.id,
        title: sharedChat.title,
        share_id: sharedChat.share_id,
        share_date: sharedChat.share_date,
        update_time: sharedChat.update_time,
      },
      messages: [],
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to get shared messages:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

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
