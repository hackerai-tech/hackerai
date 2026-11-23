import { act, renderHook, waitFor } from "@testing-library/react";

type Pending = Array<{
  id: string;
  text: string;
  runId: string;
  createdAt: number;
  claimed: boolean;
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

const { useUnreadSteerRequeue } =
  require("../useUnreadSteerRequeue") as typeof import("../useUnreadSteerRequeue");

const steer = (
  id: string,
  text: string,
  createdAt = Date.now(),
  claimed = false,
) => ({ id, text, runId: "run-1", createdAt, claimed });

const render = (
  onRequeue: jest.Mock,
  options: {
    runActive?: boolean;
    inTranscript?: string[];
    transcriptReady?: boolean;
  } = {},
) =>
  renderHook(
    ({ runActive, transcriptReady }) =>
      useUnreadSteerRequeue({
        chatId: "chat-1",
        enabled: true,
        runActive,
        transcriptReady,
        isInTranscript: (id) => options.inTranscript?.includes(id) ?? false,
        onRequeue,
      }),
    {
      initialProps: {
        runActive: options.runActive ?? false,
        transcriptReady: options.transcriptReady ?? true,
      },
    },
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

    rerender({ runActive: false, transcriptReady: true });
    expect(result.current.recovering).toBe(true);
    await waitFor(() => expect(onRequeue).toHaveBeenCalledTimes(1));
    expect(onRequeue).toHaveBeenCalledWith(
      "chat-1",
      [{ text: "Also check X", timestamp: expect.any(Number) }],
      false,
    );

    // A stale snapshot listing the same steers must not queue them again.
    await act(async () =>
      rerender({ runActive: false, transcriptReady: true }),
    );
    expect(mockWithdraw).toHaveBeenCalledTimes(2);
  });

  it("waits for the saved transcript before deciding a claimed steer was unread", async () => {
    mockPending = [steer("claimed", "Use staging", Date.now(), true)];
    mockWithdraw.mockResolvedValue({
      outcome: "withdrawn",
      text: "Use staging",
    });
    const onRequeue = jest.fn();
    const { result, rerender } = render(onRequeue, {
      transcriptReady: false,
      inTranscript: ["claimed"],
    });
    await act(async () => {});
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(result.current.recovering).toBe(true);

    rerender({ runActive: false, transcriptReady: true });
    await waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith("chat-1", [], false),
    );
  });

  it("drops a steer the transcript already shows instead of sending it twice", async () => {
    mockPending = [steer("shown", "Use staging")];
    mockWithdraw.mockResolvedValue({
      outcome: "withdrawn",
      text: "Use staging",
    });
    const onRequeue = jest.fn();
    render(onRequeue, { inTranscript: ["shown"] });
    await waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith("chat-1", [], false),
    );
  });

  it("holds steers left from an earlier visit instead of sending them", async () => {
    mockPending = [steer("old", "From yesterday", 1)];
    mockWithdraw.mockResolvedValue({
      outcome: "withdrawn",
      text: "From yesterday",
    });
    const onRequeue = jest.fn();
    render(onRequeue);
    await waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith(
        "chat-1",
        [{ text: "From yesterday", timestamp: 1 }],
        true,
      ),
    );
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
      expect(onRequeue).toHaveBeenLastCalledWith(
        "chat-1",
        [{ text: "Also check X", timestamp: expect.any(Number) }],
        false,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
