import { act, renderHook, waitFor } from "@testing-library/react";

type Row = {
  id: string;
  text: string;
  sentAt: number;
  fromSteer: boolean;
  files?: unknown[];
  dispatchClaimedAt?: number;
};
let mockRows: Row[] | undefined;
const mockEnqueue = jest.fn<Promise<null>, [Record<string, unknown>]>();
const mockUpdate = jest.fn<Promise<null>, [Record<string, unknown>]>();
const mockRemove = jest.fn<Promise<null>, [Record<string, unknown>]>();

jest.mock("@/convex/_generated/api", () => ({
  api: {
    queuedMessages: {
      list: "list",
      enqueue: "enqueue",
      update: "update",
      remove: "remove",
    },
  },
}));
jest.mock("convex/react", () => ({
  useQuery: (_query: string, args: unknown) =>
    args === "skip" ? undefined : mockRows,
  useMutation: (name: string) =>
    name === "enqueue"
      ? mockEnqueue
      : name === "update"
        ? mockUpdate
        : mockRemove,
}));
jest.mock("convex/values", () => ({
  ConvexError: class ConvexError extends Error {
    constructor(readonly data: { code: string; message: string }) {
      super(data.message);
    }
  },
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));

const { useServerMessageQueue, markQueuedHere } =
  require("../useServerMessageQueue") as typeof import("../useServerMessageQueue");
const { ConvexError } = require("convex/values") as {
  ConvexError: new (data: { code: string; message: string }) => Error;
};

const render = () =>
  renderHook(() =>
    useServerMessageQueue({
      userId: "user-1",
      chatId: "chat-1",
      enabled: true,
    }),
  );

describe("useServerMessageQueue", () => {
  beforeEach(() => {
    mockRows = [];
    mockEnqueue.mockReset().mockResolvedValue(null);
    mockUpdate.mockReset().mockResolvedValue(null);
    mockRemove.mockReset().mockResolvedValue(null);
  });

  it("stores this tab's message and lets only this tab send it automatically", async () => {
    const { result, rerender } = render();
    let id: string | undefined;
    act(() => {
      id = result.current.queueMessage("Also check X");
    });
    // Visible before the server confirms it.
    expect(result.current.messageQueue).toEqual([
      expect.objectContaining({ id, text: "Also check X" }),
    ]);
    await waitFor(() =>
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: "chat-1", id, text: "Also check X" }),
      ),
    );
    mockRows = [{ id: id!, text: "Also check X", sentAt: 1, fromSteer: false }];
    // A row another tab or device queued, or one from before a reload.
    mockRows.push({
      id: "elsewhere",
      text: "Old",
      sentAt: 2,
      fromSteer: false,
    });
    rerender();
    expect(
      result.current.messageQueue.map((item) => [item.id, item.held]),
    ).toEqual([
      [id, undefined],
      ["elsewhere", true],
    ]);
  });

  it("keeps a message queued before the server created the chat and stores it later", async () => {
    jest.useFakeTimers();
    try {
      mockEnqueue
        .mockRejectedValueOnce(
          new ConvexError({ code: "ACCESS_DENIED", message: "Chat not found" }),
        )
        .mockResolvedValue(null);
      const { result } = render();
      act(() => {
        result.current.queueMessage("Queued during the first response");
      });
      await act(async () => {});
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(result.current.messageQueue).toHaveLength(1);
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      // Accepted: never sent to the server again while it waits to be listed.
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(mockEnqueue).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("drops a stored message once the server no longer lists it", async () => {
    const { result, rerender } = render();
    let id: string | undefined;
    act(() => {
      id = result.current.queueMessage("Sent from this tab");
    });
    await waitFor(() => expect(mockEnqueue).toHaveBeenCalled());
    mockRows = [
      { id: id!, text: "Sent from this tab", sentAt: 1, fromSteer: false },
    ];
    rerender();
    // Saving it as a user message retired the row on the server.
    mockRows = [];
    rerender();
    expect(result.current.messageQueue).toEqual([]);
  });

  it("hides a removed message at once and removes it on the server", () => {
    mockRows = [{ id: "a", text: "Remove me", sentAt: 1, fromSteer: true }];
    const { result } = render();
    act(() => result.current.removeQueuedMessage("a"));
    expect(result.current.messageQueue).toEqual([]);
    expect(mockRemove).toHaveBeenCalledWith({ chatId: "chat-1", id: "a" });
  });

  it("refuses an eleventh message without storing it", () => {
    mockRows = Array.from({ length: 10 }, (_, index) => ({
      id: `q${index}`,
      text: "queued",
      sentAt: index,
      fromSteer: false,
    }));
    const { result } = render();
    let id: string | undefined = "unset";
    act(() => {
      id = result.current.queueMessage("One too many");
    });
    expect(id).toBeUndefined();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("shows an edit at once and keeps it until the server reflects it", () => {
    mockRows = [{ id: "a", text: "Old", sentAt: 1, fromSteer: false }];
    const { result, rerender } = render();
    act(() => result.current.updateQueuedMessage("a", "New"));
    expect(result.current.messageQueue[0].text).toBe("New");
    expect(mockUpdate).toHaveBeenCalledWith({
      chatId: "chat-1",
      id: "a",
      text: "New",
    });
    // A snapshot from before the edit must not undo it on screen.
    mockRows = [{ id: "a", text: "Old", sentAt: 1, fromSteer: false }];
    rerender();
    expect(result.current.messageQueue[0].text).toBe("New");
  });

  it("removes a stored message on the server even before a snapshot lists it", async () => {
    const { result } = render();
    let id: string | undefined;
    act(() => {
      id = result.current.queueMessage("Remove me before the snapshot");
    });
    await waitFor(() => expect(mockEnqueue).toHaveBeenCalled());
    await act(async () => {});
    act(() => result.current.removeQueuedMessage(id!));
    expect(mockRemove).toHaveBeenCalledWith({ chatId: "chat-1", id });
    // The stored row arrives in a snapshot taken before the removal.
    expect(result.current.messageQueue).toEqual([]);
  });

  it("shows a held row as sendable once this tab marks it as its own", () => {
    mockRows = [{ id: "steer-x", text: "Unread", sentAt: 1, fromSteer: true }];
    const { result } = render();
    expect(result.current.messageQueue[0].held).toBe(true);
    act(() => markQueuedHere("steer-x"));
    expect(result.current.messageQueue[0].held).toBeUndefined();
  });

  it("keeps messages queued before the rollout resolved, with their IDs", async () => {
    const { result } = render();
    act(() =>
      result.current.adoptLocalMessages("chat-1", [
        { id: "early", text: "Queued while loading", timestamp: 5 },
      ]),
    );
    expect(result.current.messageQueue).toEqual([
      expect.objectContaining({ id: "early", text: "Queued while loading" }),
    ]);
    expect(result.current.messageQueue[0].held).toBeUndefined();
    await waitFor(() =>
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ id: "early", sentAt: 5 }),
      ),
    );
  });

  it("stores messages adopted for a chat that is not open", async () => {
    const { result } = render();
    act(() =>
      result.current.adoptLocalMessages("chat-2", [
        { id: "other-chat", text: "For another chat", timestamp: 7 },
      ]),
    );
    await waitFor(() =>
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: "chat-2", id: "other-chat" }),
      ),
    );
    // It belongs to that chat's queue, not the open one.
    expect(result.current.messageQueue).toEqual([]);
  });

  it("shows a message again when removing its stored copy fails", async () => {
    let finishStore!: () => void;
    mockEnqueue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStore = () => resolve(null);
        }),
    );
    mockRemove.mockRejectedValueOnce(new Error("offline"));
    const { result } = render();
    let id: string | undefined;
    act(() => {
      id = result.current.queueMessage("Remove me while storing");
    });
    await waitFor(() => expect(mockEnqueue).toHaveBeenCalled());
    act(() => result.current.removeQueuedMessage(id!));
    expect(result.current.messageQueue).toEqual([]);
    await act(async () => finishStore());
    await waitFor(() => expect(mockRemove).toHaveBeenCalled());
    await waitFor(() =>
      expect(result.current.messageQueue.map((item) => item.id)).toEqual([id]),
    );
  });

  it("shows a server send, and stops showing it when its claim expires", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(100_000);
      mockRows = [
        {
          id: "a",
          text: "Sent by the server",
          sentAt: 1,
          fromSteer: false,
          dispatchClaimedAt: 100_000,
        },
      ];
      const { result } = render();
      expect(result.current.messageQueue[0]).toEqual(
        expect.objectContaining({ dispatching: true, onServer: true }),
      );
      // The dispatcher died: nothing writes the row again.
      act(() => {
        jest.advanceTimersByTime(2 * 60 * 1000 + 100);
      });
      expect(result.current.messageQueue[0].dispatching).toBeUndefined();
      // An expired lease schedules nothing more: no refresh loop.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
