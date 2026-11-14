import "@testing-library/jest-dom";
import { act, renderHook } from "@testing-library/react";
import { useFindingRetestState } from "../FindingAgentRetests";
import { useFindingHuntState } from "../FindingVariantHunts";

// Both Agent check histories share one request lifecycle; each case runs
// against both callers so neither adapter can drift from it.
const idleRetests = { enabled: true, chat_title: "Scan", retests: [] };
const runningRetests = {
  ...idleRetests,
  retests: [{ retest_id: "r1", status: "running" }],
};
const idleHunts = { enabled: true, chat_title: "Scan", hunts: [] };
const runningHunts = {
  ...idleHunts,
  hunts: [{ hunt_id: "h1", status: "running", candidates: [] }],
};

const CALLERS = [
  ["retests", useFindingRetestState, idleRetests, runningRetests],
  ["hunts", useFindingHuntState, idleHunts, runningHunts],
] as const;

const ok = (body: unknown) =>
  ({ ok: true, json: async () => body }) as Response;

let fetchMock: jest.Mock;
let visibility: DocumentVisibilityState;

/** Resolves the next read on demand, to observe in-flight behavior. */
const deferredRead = () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  return (body: unknown) => act(async () => resolve(ok(body)));
};

const setVisibility = (next: DocumentVisibilityState) =>
  act(() => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  });

const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  jest.useRealTimers();
  delete (global as any).fetch;
  delete (document as any).visibilityState;
});

describe.each(CALLERS)("%s history", (_name, useHistory, idle, running) => {
  it("shows a change from another tab on focus, visible return or reconnect, with one read at a time", async () => {
    fetchMock.mockResolvedValueOnce(ok(idle));
    const { result } = renderHook(() => useHistory("finding-1"));
    await act(async () => {});
    expect(result.current).toEqual(idle);

    const finishFocusRead = deferredRead();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Switching back fires visibility and focus together; they join one read.
    setVisibility("visible");
    act(() => window.dispatchEvent(new Event("online")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await finishFocusRead(running);
    expect(result.current).toEqual(running);

    // A hidden tab makes no requests, then catches up when shown again.
    setVisibility("hidden");
    act(() => window.dispatchEvent(new Event("online")));
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(ok(idle));
    setVisibility("visible");
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual(idle);

    fetchMock.mockResolvedValueOnce(ok(running));
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toEqual(running);
  });

  it("polls a visible idle view within 30s and a running one every 5s", async () => {
    fetchMock.mockResolvedValue(ok(idle));
    renderHook(() => useHistory("finding-1"));
    await act(async () => {});
    await advance(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(ok(running));
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // A read slower than the interval never overlaps the next one.
    const finishSlow = deferredRead();
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await finishSlow(running);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("retries a failed first read and keeps the last good state when a refresh fails", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ok(running))
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { result } = renderHook(() => useHistory("finding-1"));
    await act(async () => {});
    // No rollout-gated action is offered before a read succeeds.
    expect(result.current).toEqual({ enabled: false });
    await advance(2_000);
    expect(result.current).toEqual(running);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual(running);
  });

  it("makes no further requests when the rollout is off", async () => {
    fetchMock.mockResolvedValue(ok({ enabled: false }));
    const { result } = renderHook(() => useHistory("finding-1"));
    await act(async () => {});
    expect(result.current).toEqual({ enabled: false });
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores responses for a previous finding and stops after unmount", async () => {
    const finishFirst = deferredRead();
    fetchMock.mockResolvedValueOnce(ok(idle));
    const { result, rerender, unmount } = renderHook(
      ({ id }) => useHistory(id),
      { initialProps: { id: "finding-a" } },
    );
    rerender({ id: "finding-b" });
    await act(async () => {});
    expect(result.current).toEqual(idle);
    await finishFirst(running);
    expect(result.current).toEqual(idle);

    unmount();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
