import { act, renderHook, waitFor } from "@testing-library/react";

type Pending = Array<{
  id: string;
  text: string;
  runId: string;
  sentAt: number;
}>;
let mockPending: Pending | undefined;
const mockWithdraw = jest.fn<
  Promise<{ outcome: "withdrawn"; text: string } | { outcome: "not_found" }>,
  [{ chatId: string; id: string }]
>();

jest.mock("@/convex/_generated/api", () => ({
  api: { agentSteers: { listPending: "listPending", withdraw: "withdraw" } },
}));
jest.mock("convex/react", () => ({
  useQuery: (_query: string, args: unknown) =>
    args === "skip" ? undefined : mockPending,
  useMutation: () => mockWithdraw,
}));

const { useUnreadSteerRequeue, rememberSteerSentHere } =
  require("../useUnreadSteerRequeue") as typeof import("../useUnreadSteerRequeue");

// Sent from this tab during this visit unless a test says otherwise.
const steer = (
  id: string,
  text: string,
  sentAt = Date.now() + 1_000,
  sentHere = true,
) => {
  if (sentHere) rememberSteerSentHere(id);
  return { id, text, runId: "run-1", sentAt };
};

const render = (onRequeue: jest.Mock, options: { runActive?: boolean } = {}) =>
  renderHook(
    ({ runActive }) =>
      useUnreadSteerRequeue({
        chatId: "chat-1",
        enabled: true,
        runActive,
        onRequeue,
      }),
    { initialProps: { runActive: options.runActive ?? false } },
  );

describe("useUnreadSteerRequeue", () => {
  beforeEach(() => {
    mockWithdraw.mockReset();
    mockPending = [
      steer("read", "Already read"),
      steer("late", "Also check X"),
    ];
  });

  it("queues only steers the run did not read, once, after the run ends", async () => {
    mockWithdraw.mockImplementation(async ({ id }) =>
      id === "late"
        ? { outcome: "withdrawn", text: "Also check X" }
        : { outcome: "not_found" },
    );
    const onRequeue = jest.fn();
    const { result, rerender } = render(onRequeue, { runActive: true });
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(result.current.recovering).toBe(false);

    rerender({ runActive: false });
    expect(result.current.recovering).toBe(true);
    await waitFor(() => expect(onRequeue).toHaveBeenCalledTimes(1));
    expect(onRequeue).toHaveBeenCalledWith("chat-1", [
      {
        text: "Also check X",
        timestamp: expect.any(Number),
        sentHere: true,
        held: false,
      },
    ]);

    // A stale snapshot listing the same steers must not queue them again.
    await act(async () => rerender({ runActive: false }));
    expect(mockWithdraw).toHaveBeenCalledTimes(2);
  });

  it("holds steers sent before this visit instead of sending them", async () => {
    mockPending = [steer("old", "From yesterday", 1)];
    mockWithdraw.mockResolvedValue({
      outcome: "withdrawn",
      text: "From yesterday",
    });
    const onRequeue = jest.fn();
    render(onRequeue);
    await waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith("chat-1", [
        { text: "From yesterday", timestamp: 1, sentHere: true, held: true },
      ]),
    );
  });

  it("holds a steer from an earlier visit to the chat in this page session", async () => {
    const sentAt = Date.now();
    mockPending = [steer("earlier", "From before leaving", sentAt)];
    mockWithdraw.mockResolvedValue({
      outcome: "withdrawn",
      text: "From before leaving",
    });
    const onRequeue = jest.fn();
    const { rerender } = renderHook(
      ({ chatId, runActive }) =>
        useUnreadSteerRequeue({
          chatId,
          enabled: true,
          runActive,
          onRequeue,
        }),
      { initialProps: { chatId: "chat-1", runActive: true } },
    );
    rerender({ chatId: "chat-2", runActive: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    rerender({ chatId: "chat-1", runActive: false });
    await waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith("chat-1", [
        {
          text: "From before leaving",
          timestamp: sentAt,
          sentHere: true,
          held: true,
        },
      ]),
    );
  });

  it("holds a steer sent from another device whatever its clock says", async () => {
    // A device with a fast clock: comparing times would call it this visit's.
    mockPending = [
      steer("elsewhere", "From my laptop", Date.now() + 3_600_000, false),
    ];
    mockWithdraw.mockResolvedValue({
      outcome: "withdrawn",
      text: "From my laptop",
    });
    const onRequeue = jest.fn();
    render(onRequeue);
    await waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith("chat-1", [
        {
          text: "From my laptop",
          timestamp: expect.any(Number),
          sentHere: false,
          held: true,
        },
      ]),
    );
  });

  it("holds a steer restored after the user left for another chat", async () => {
    mockPending = [steer("late", "Also check X")];
    let finish!: (result: { outcome: "withdrawn"; text: string }) => void;
    mockWithdraw.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onRequeue = jest.fn();
    const { rerender } = renderHook(
      ({ chatId }) =>
        useUnreadSteerRequeue({
          chatId,
          enabled: true,
          runActive: false,
          onRequeue,
        }),
      { initialProps: { chatId: "chat-1" } },
    );
    await act(async () => {});
    // The withdrawal is still in flight when the user moves away.
    rerender({ chatId: "chat-2" });
    await act(async () =>
      finish({ outcome: "withdrawn", text: "Also check X" }),
    );
    expect(onRequeue).toHaveBeenCalledWith("chat-1", [
      expect.objectContaining({ text: "Also check X", held: true }),
    ]);
  });

  it("retries a failed withdrawal without a new snapshot", async () => {
    jest.useFakeTimers();
    try {
      mockPending = [steer("late", "Also check X")];
      mockWithdraw
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ outcome: "withdrawn", text: "Also check X" });
      const onRequeue = jest.fn();
      render(onRequeue);
      await act(async () => {});
      expect(mockWithdraw).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(mockWithdraw).toHaveBeenCalledTimes(2);
      expect(onRequeue).toHaveBeenLastCalledWith("chat-1", [
        {
          text: "Also check X",
          timestamp: expect.any(Number),
          sentHere: true,
          held: false,
        },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps send order for tied steers when the first withdrawal fails", async () => {
    jest.useFakeTimers();
    try {
      const sentAt = Date.now() + 1_000;
      mockPending = [
        steer("first", "First", sentAt),
        steer("second", "Second", sentAt),
      ];
      mockWithdraw
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(async ({ id }) => ({
          outcome: "withdrawn",
          text: id === "first" ? "First" : "Second",
        }));
      const onRequeue = jest.fn();
      render(onRequeue);
      await act(async () => {});
      // The second steer was not withdrawn ahead of the failed first one.
      expect(mockWithdraw).toHaveBeenCalledTimes(1);
      expect(onRequeue).toHaveBeenLastCalledWith("chat-1", []);
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(onRequeue).toHaveBeenLastCalledWith("chat-1", [
        { text: "First", timestamp: sentAt, sentHere: true, held: false },
        { text: "Second", timestamp: sentAt, sentHere: true, held: false },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("schedules no retry for a withdrawal that fails after unmount", async () => {
    jest.useFakeTimers();
    try {
      mockPending = [steer("late", "Also check X")];
      let reject!: (error: Error) => void;
      mockWithdraw.mockImplementationOnce(
        () =>
          new Promise((_, rejectWithdrawal) => {
            reject = rejectWithdrawal;
          }),
      );
      const { unmount } = render(jest.fn());
      await act(async () => {});
      expect(mockWithdraw).toHaveBeenCalledTimes(1);
      unmount();
      const setTimeoutSpy = jest.spyOn(global, "setTimeout");
      await act(async () => reject(new Error("offline")));
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(
        expect.any(Function),
        1_000,
      );
      setTimeoutSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
