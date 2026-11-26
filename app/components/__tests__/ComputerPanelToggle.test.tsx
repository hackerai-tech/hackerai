import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import {
  useWorkspaceFilesEnabled,
  WorkspaceFilesShortcut,
} from "../ComputerPanelToggle";
import { useGlobalState } from "../../contexts/GlobalState";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";

jest.mock("../../contexts/GlobalState", () => ({ useGlobalState: jest.fn() }));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(() => true),
}));
jest.mock("@/app/hooks/useTauri", () => ({ isTauriEnvironment: () => false }));

const fetchMock = jest.fn();
const response = (status: number, enabled = false) => ({
  ok: status === 200,
  status,
  json: async () => ({ enabled }),
});
const tracked = (event: string) =>
  (captureQueuedAuthenticatedEvent as jest.Mock).mock.calls
    .filter(([call]) => call.event === event)
    .map(([call]) => call.properties);
function swrWrapper() {
  const cache = new Map();
  return function IsolatedSWR({ children }: { children: ReactNode }) {
    return (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        {children}
      </SWRConfig>
    );
  };
}
function mountAvailability() {
  return renderHook(() => useWorkspaceFilesEnabled("chat"), {
    wrapper: swrWrapper(),
  });
}

const openSidebar = jest.fn();
const closeSidebar = jest.fn();
const setSidebarOpen = jest.fn();
function mockPanel(sidebarOpen: boolean) {
  (useGlobalState as jest.Mock).mockReturnValue({
    sidebarOpen,
    openSidebar,
    closeSidebar,
    setSidebarOpen,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  global.fetch = fetchMock;
  openSidebar.mockClear();
  closeSidebar.mockClear();
  setSidebarOpen.mockClear();
  (captureQueuedAuthenticatedEvent as jest.Mock).mockClear();
  mockPanel(false);
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

it("opens Files from the header every time, never closing the open panel, and reports exposure once per chat", async () => {
  fetchMock.mockResolvedValue(response(200, true));
  const { rerender } = render(<WorkspaceFilesShortcut chatId="chat" />, {
    wrapper: swrWrapper(),
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  const files = screen.getByRole("button", { name: "Open files" });
  expect(files).toHaveTextContent("Files");
  expect(tracked("workspace_files_header_exposed")).toEqual([
    { telemetry_version: 1, surface: "web" },
  ]);

  const filesSelection = {
    kind: "workspace-files",
    chatId: "chat",
    toolCallId: "workspace-files:chat",
  };
  fireEvent.click(files);
  expect(openSidebar).toHaveBeenLastCalledWith(filesSelection);
  // Already open (for example on Activity): activation still targets Files.
  mockPanel(true);
  rerender(<WorkspaceFilesShortcut chatId="chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Open files" }));
  expect(openSidebar).toHaveBeenCalledTimes(2);
  expect(openSidebar).toHaveBeenLastCalledWith(filesSelection);
  expect(closeSidebar).not.toHaveBeenCalled();
  expect(setSidebarOpen).not.toHaveBeenCalled();
  expect(tracked("workspace_files_header_clicked")).toEqual([
    { telemetry_version: 1, surface: "web" },
    { telemetry_version: 1, surface: "web" },
  ]);

  // Re-renders do not repeat exposure; another chat in the same header does.
  expect(tracked("workspace_files_header_exposed")).toHaveLength(1);
  rerender(<WorkspaceFilesShortcut chatId="other" />);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(tracked("workspace_files_header_exposed")).toHaveLength(2);
});

it.each([200, 403])(
  "keeps the header shortcut hidden and unreported for a disabled or unauthorized chat (%s)",
  async (status) => {
    fetchMock.mockResolvedValue(response(status));
    render(<WorkspaceFilesShortcut chatId="chat" />, {
      wrapper: swrWrapper(),
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.queryByRole("button", { name: "Open files" }),
    ).not.toBeInTheDocument();
    expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
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
