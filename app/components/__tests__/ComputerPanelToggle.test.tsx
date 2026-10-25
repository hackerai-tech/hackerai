import { act, cleanup, renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useWorkspaceFilesEnabled } from "../ComputerPanelToggle";

jest.mock("../../contexts/GlobalState", () => ({ useGlobalState: jest.fn() }));

const fetchMock = jest.fn();
const response = (status: number, enabled = false) => ({
  ok: status === 200,
  status,
  json: async () => ({ enabled }),
});
function mountAvailability() {
  const cache = new Map();
  return renderHook(() => useWorkspaceFilesEnabled("chat"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        {children}
      </SWRConfig>
    ),
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  global.fetch = fetchMock;
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

it.each([503, 429, "network"])(
  "recovers availability after a transient %s failure",
  async (failure) => {
    if (failure === "network")
      fetchMock.mockRejectedValueOnce(new Error("offline"));
    else fetchMock.mockResolvedValueOnce(response(failure as number));
    fetchMock.mockResolvedValue(response(200, true));
    const { result } = mountAvailability();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

it.each([200, 403])(
  "keeps a valid disabled or unauthorized response (%s) hidden without retrying",
  async (status) => {
    fetchMock.mockResolvedValue(response(status));
    const { result } = mountAvailability();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it("stops retrying a persistent failure after two retries", async () => {
  fetchMock.mockResolvedValue(response(503));
  const { result } = mountAvailability();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120_000);
  });
  expect(result.current).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
