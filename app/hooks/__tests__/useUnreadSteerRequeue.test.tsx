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
// The server queue hook is only a module-level flag store here.
jest.mock("convex/values", () => ({ ConvexError: class extends Error {} }));

const { useUnreadSteerRequeue, rememberSteerSentHere, rememberStoppedRun } =
  require("../useUnreadSteerRequeue") as typeof import("../useUnreadSteerRequeue");
const { isQueuedHere } =
  require("../useServerMessageQueue") as typeof import("../useServerMessageQueue");

let nextId = 0;
// Sent from this tab during this visit unless a test says otherwise.
const steer = (text: string, sentAt = Date.now() + 1_000, sentHere = true) => {
  const id = `steer-${++nextId}`;
  if (sentHere) rememberSteerSentHere(id);
  return { id, text, runId: "run-1", sentAt };
};
const withdrawAll = () =>
  mockWithdraw.mockImplementation(async () => ({
    outcome: "withdrawn",
    text: "x",
  }));

// Withdrawn rows stay in this fake snapshot, so wait for the async batch.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const render = (options: { runActive?: boolean; chatId?: string } = {}) =>
  renderHook(
    ({ runActive, chatId }) =>
      useUnreadSteerRequeue({ chatId, enabled: true, runActive }),
    {
      initialProps: {
        runActive: options.runActive ?? false,
        chatId: options.chatId ?? "chat-1",
      },
    },
  );

describe("useUnreadSteerRequeue", () => {
  beforeEach(() => {
    mockWithdraw.mockReset();
  });

  it("returns only unread steers, once, and only after the run ends", async () => {
    const read = steer("Already read");
    const late = steer("Also check X");
    mockPending = [read, late];
    mockWithdraw.mockImplementation(async ({ id }) =>
      id === late.id
        ? { outcome: "withdrawn", text: "Also check X" }
        : { outcome: "not_found" },
    );
    const { result, rerender } = render({ runActive: true });
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(result.current.recovering).toBe(false);

    rerender({ runActive: false, chatId: "chat-1" });
    expect(result.current.recovering).toBe(true);
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(2));
    await settle();
    // This tab sent it during this visit: the queue may send it again.
    expect(isQueuedHere(late.id)).toBe(true);
    expect(isQueuedHere(read.id)).toBe(false);

    // A stale snapshot listing the same steers must not withdraw them again.
    await act(async () => rerender({ runActive: false, chatId: "chat-1" }));
    expect(mockWithdraw).toHaveBeenCalledTimes(2);
  });

  it("holds steers sent before this visit, from another device, or to a stopped run", async () => {
    const old = steer("From yesterday", 1);
    // A device with a fast clock: comparing times would call it this visit's.
    const elsewhere = steer("From my laptop", Date.now() + 3_600_000, false);
    rememberStoppedRun("run-stopped");
    const stopped = { ...steer("Also check X"), runId: "run-stopped" };
    mockPending = [old, elsewhere, stopped];
    withdrawAll();
    render();
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(3));
    await settle();
    for (const held of [old, elsewhere, stopped])
      expect(isQueuedHere(held.id)).toBe(false);
  });

  it("holds a steer from an earlier visit to the chat in this page session", async () => {
    const earlier = steer("From before leaving", Date.now());
    mockPending = [earlier];
    withdrawAll();
    const { rerender } = render({ runActive: true });
    rerender({ chatId: "chat-2", runActive: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    rerender({ chatId: "chat-1", runActive: false });
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalled());
    await settle();
    expect(isQueuedHere(earlier.id)).toBe(false);
  });

  it("holds a steer whose withdrawal finishes after the user left the chat", async () => {
    const late = steer("Also check X");
    mockPending = [late];
    let finish!: (result: { outcome: "withdrawn"; text: string }) => void;
    mockWithdraw.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount } = render();
    await act(async () => {});
    unmount();
    await act(async () => finish({ outcome: "withdrawn", text: "x" }));
    expect(isQueuedHere(late.id)).toBe(false);
  });

  it("tries again on a later snapshot when the run still held the steer", async () => {
    const late = steer("Also check X");
    mockPending = [late];
    mockWithdraw
      .mockResolvedValueOnce({ outcome: "not_found" })
      .mockResolvedValueOnce({ outcome: "withdrawn", text: "Also check X" });
    const { rerender } = render();
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(1));
    // The server still listed it: the run ended without saving it.
    mockPending = [...mockPending];
    await act(async () => rerender({ runActive: false, chatId: "chat-1" }));
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(isQueuedHere(late.id)).toBe(true));
  });

  it("retries a failed withdrawal without a new snapshot and keeps the queue waiting", async () => {
    jest.useFakeTimers();
    try {
      const first = steer("First");
      const second = steer("Second");
      mockPending = [first, second];
      mockWithdraw
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ outcome: "withdrawn", text: "x" });
      const { result } = render();
      await act(async () => {});
      // The second is not withdrawn ahead of the failed first one.
      expect(mockWithdraw).toHaveBeenCalledTimes(1);
      expect(result.current.recovering).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(mockWithdraw).toHaveBeenCalledTimes(3);
      expect(isQueuedHere(first.id) && isQueuedHere(second.id)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("schedules no retry for a withdrawal that fails after unmount", async () => {
    jest.useFakeTimers();
    try {
      mockPending = [steer("Also check X")];
      let reject!: (error: Error) => void;
      mockWithdraw.mockImplementationOnce(
        () =>
          new Promise((_, rejectWithdrawal) => {
            reject = rejectWithdrawal;
          }),
      );
      const { unmount } = render();
      await act(async () => {});
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
