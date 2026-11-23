import { act, renderHook, waitFor } from "@testing-library/react";

let mockPending:
  | Array<{ id: string; text: string; runId: string; createdAt: number }>
  | undefined;
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

describe("useUnreadSteerRequeue", () => {
  beforeEach(() => {
    mockWithdraw.mockReset();
    mockPending = [
      {
        id: "read",
        text: "Already read",
        runId: "run-1",
        createdAt: Date.now(),
      },
      {
        id: "late",
        text: "Also check X",
        runId: "run-1",
        createdAt: Date.now(),
      },
    ];
  });

  it("queues only steers the run did not read, once, after the run ends", async () => {
    mockWithdraw.mockImplementation(async ({ id }) =>
      id === "late"
        ? { outcome: "withdrawn", text: "Also check X" }
        : { outcome: "not_found" },
    );
    const onRequeue = jest.fn();
    const { rerender } = renderHook(
      ({ runActive }) =>
        useUnreadSteerRequeue({
          chatId: "chat-1",
          enabled: true,
          runActive,
          onRequeue,
        }),
      { initialProps: { runActive: true } },
    );
    expect(mockWithdraw).not.toHaveBeenCalled();

    rerender({ runActive: false });
    await waitFor(() => expect(onRequeue).toHaveBeenCalledTimes(1));
    expect(onRequeue).toHaveBeenCalledWith(
      "chat-1",
      [{ text: "Also check X", timestamp: expect.any(Number) }],
      false,
    );

    // A stale snapshot listing the same steers must not queue them again.
    await act(async () => rerender({ runActive: false }));
    expect(mockWithdraw).toHaveBeenCalledTimes(2);
  });

  it("holds steers left from an earlier visit instead of sending them", async () => {
    mockPending = [
      { id: "old", text: "From yesterday", runId: "run-0", createdAt: 1 },
    ];
    mockWithdraw.mockResolvedValue({
      outcome: "withdrawn",
      text: "From yesterday",
    });
    const onRequeue = jest.fn();
    renderHook(() =>
      useUnreadSteerRequeue({
        chatId: "chat-1",
        enabled: true,
        runActive: false,
        onRequeue,
      }),
    );
    await waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith(
        "chat-1",
        [{ text: "From yesterday", timestamp: 1 }],
        true,
      ),
    );
  });
});
