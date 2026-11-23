import { act, renderHook, waitFor } from "@testing-library/react";
import { useFollowUpBehavior } from "@/app/hooks/useFollowUpBehavior";

const respond = (enabled: boolean) =>
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: jest.fn(async () => ({
      ok: true,
      json: async () => ({ enabled }),
    })),
  });

const settle = async (result: {
  current: ReturnType<typeof useFollowUpBehavior>;
}) => {
  await waitFor(() =>
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/experiments/agent-steering",
      expect.anything(),
    ),
  );
  await act(async () => {});
  return result.current;
};

describe("useFollowUpBehavior", () => {
  beforeEach(() => localStorage.clear());

  it("steers by default once the rollout is on, even with the old default saved", async () => {
    // Every earlier load wrote "queue" here, so it is not an explicit choice.
    localStorage.setItem("queue-behavior", "queue");
    respond(true);
    const { result } = renderHook(() => useFollowUpBehavior("user-1"));
    expect(result.current.queueBehavior).toBe("queue");
    expect((await settle(result)).queueBehavior).toBe("steer");
  });

  it("keeps an existing Stop & send choice and later explicit choices", async () => {
    localStorage.setItem("queue-behavior", "stop-and-send");
    respond(true);
    const { result } = renderHook(() => useFollowUpBehavior("user-1"));
    expect((await settle(result)).queueBehavior).toBe("stop-and-send");

    act(() => result.current.setQueueBehavior("queue"));
    expect(result.current.queueBehavior).toBe("queue");
    const { result: reloaded } = renderHook(() =>
      useFollowUpBehavior("user-1"),
    );
    expect((await settle(reloaded)).queueBehavior).toBe("queue");
  });

  it("keeps the previous behavior when the rollout is off", async () => {
    localStorage.setItem("follow-up-behavior", "steer");
    respond(false);
    const { result } = renderHook(() => useFollowUpBehavior("user-1"));
    const settled = await settle(result);
    expect(settled.agentSteeringEnabled).toBe(false);
    expect(settled.queueBehavior).toBe("queue");
  });

  it("keeps a choice made while the rollout is off once it turns on", async () => {
    localStorage.setItem("follow-up-behavior", "queue");
    respond(false);
    const { result } = renderHook(() => useFollowUpBehavior("user-1"));
    await settle(result);
    act(() => result.current.setQueueBehavior("stop-and-send"));

    respond(true);
    const { result: enabled } = renderHook(() => useFollowUpBehavior("user-1"));
    expect((await settle(enabled)).queueBehavior).toBe("stop-and-send");
  });
});
