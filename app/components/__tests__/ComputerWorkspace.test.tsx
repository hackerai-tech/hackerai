import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ComputerWorkspace } from "../ComputerWorkspace";
import type { SidebarContent } from "@/types/chat";
import { downloadFile } from "@/lib/utils/file-download";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";

const tracked = (event: string) =>
  (captureQueuedAuthenticatedEvent as jest.Mock).mock.calls
    .filter(([call]) => call.event === event)
    .map(([call]) => call.properties);
const mockGetUrl = jest.fn();
let mockOverlay = false;
let mockPhone = false;
let mockNative = false;
const mockSavedQuery = jest.fn();
let mockSavedPage: { results: unknown[]; status: string; loadMore: () => void };
jest.mock("convex/react", () => ({
  useAction: () => mockGetUrl,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: (...args: unknown[]) => {
    mockSavedQuery(...args);
    return args[1] === "skip"
      ? { results: [], status: "LoadingFirstPage", loadMore: () => {} }
      : mockSavedPage;
  },
}));
jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(() => true),
}));
jest.mock("../../contexts/GlobalState", () => ({
  useGlobalState: () => ({ sandboxPreference: "cloud" }),
}));
jest.mock("@/hooks/use-workspace-layout", () => ({
  useComputerSidebarOverlay: () => mockOverlay,
}));
jest.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => mockPhone,
}));
jest.mock("../AllFilesDialog", () => ({ AllFilesDialog: () => null }));
jest.mock("../../hooks/useTauri", () => ({
  isTauriEnvironment: () => mockNative,
}));
jest.mock("@/lib/utils/file-download", () => ({ downloadFile: jest.fn() }));
const messages = ["cloud", "desktop"].map((environment, index) => ({
  id: `m${index}`,
  role: "assistant",
  parts: [
    {
      type: "tool-file",
      state: "output-available",
      toolCallId: `call${index}`,
      input: { path: "/reports/report.txt", action: "read" },
      output: {
        originalContent: `${environment} historical version`,
        fileSnapshot: {
          environment,
          identity: environment,
          capturedAt: 100 + index,
        },
      },
    },
  ],
}));
const files: SidebarContent = {
  kind: "workspace-files",
  chatId: "chat",
  toolCallId: "workspace-files:chat",
};
const activity = {
  kind: "terminal",
  toolCallId: "terminal1",
  command: "echo hello",
  output: "hello",
} as SidebarContent;
const props = {
  chatId: "chat",
  messages,
  open: true,
  selection: files,
  openRequest: 1,
  onClose: jest.fn(),
  renderActivity: () => <p>Latest activity</p>,
};

beforeEach(() => {
  mockOverlay = false;
  mockPhone = false;
  mockNative = false;
  mockGetUrl.mockReset();
  mockSavedQuery.mockClear();
  mockSavedPage = { results: [], status: "Exhausted", loadMore: () => {} };
  global.fetch = jest.fn().mockRejectedValue(new Error("offline"));
  (captureQueuedAuthenticatedEvent as jest.Mock).mockClear();
});

it("reports Files exposure and first view only once Computer and then Files are visible", () => {
  const base = { ...props, selection: activity };
  const { rerender } = render(
    <ComputerWorkspace {...base} open={false} selection={null} />,
  );
  // Mounted in the background: the Files tab has not been offered yet.
  expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
  rerender(<ComputerWorkspace {...base} />);
  expect(tracked("workspace_files_exposed")).toEqual([
    { telemetry_version: 1, surface: "web" },
  ]);
  expect(tracked("workspace_files_viewed")).toEqual([]);
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(tracked("workspace_files_viewed")).toEqual([
    { telemetry_version: 1, surface: "web" },
  ]);
  // Minimize, reopen and revisit: still one exposure and one view.
  rerender(<ComputerWorkspace {...base} open={false} selection={null} />);
  rerender(<ComputerWorkspace {...base} selection={null} />);
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(tracked("workspace_files_exposed")).toHaveLength(1);
  expect(tracked("workspace_files_viewed")).toHaveLength(1);
  const [{ dedupeKey: first }, { dedupeKey: second }] = (
    captureQueuedAuthenticatedEvent as jest.Mock
  ).mock.calls.map(([call]) => call);
  expect(first).not.toEqual(second);
  expect(first).not.toContain("chat");
});

it("reports a captured result preview from its Files tab once the tab is visible", async () => {
  render(<ComputerWorkspace {...props} />);
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[0],
  );
  expect(await screen.findByText("desktop historical version")).toBeVisible();
  expect(tracked("workspace_file_preview")).toEqual([
    {
      outcome: "success",
      file_kind: "captured_result",
      entry_point: "computer_files",
      telemetry_version: 1,
      surface: "web",
    },
  ]);
});

it("reopens an older saved report outside loaded history and downloads its exact bytes with the workspace offline", async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
  const olderReport = {
    id: "older-report",
    role: "assistant",
    fileDetails: [
      {
        fileId: "file-pdf",
        name: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: bytes.length,
      },
    ],
  };
  mockSavedPage = {
    results: [olderReport],
    status: "Exhausted",
    loadMore: () => {},
  };
  mockGetUrl.mockResolvedValue("https://signed/report");
  global.fetch = jest.fn(async (url: string) => {
    if (url !== "https://signed/report") throw new Error("workspace offline");
    let sent = false;
    return {
      ok: true,
      headers: { get: () => String(bytes.length) },
      body: {
        getReader: () => ({
          read: async () =>
            sent
              ? { done: true }
              : ((sent = true), { done: false, value: bytes }),
          cancel: async () => {},
        }),
      },
    };
  }) as unknown as typeof fetch;
  (downloadFile as jest.Mock).mockResolvedValue({ outcome: "success" });
  // Loaded history no longer contains the message that delivered the report.
  const view = { ...props, messages: [], selection: activity };
  const { rerender } = render(<ComputerWorkspace {...view} />);
  expect(mockSavedQuery.mock.calls.every(([, args]) => args === "skip")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(mockSavedQuery).toHaveBeenLastCalledWith(
    expect.anything(),
    { chatId: "chat" },
    { initialNumItems: 14 },
  );
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getByRole("button", { name: /report\.pdf/ }),
  );
  expect(screen.getByRole("tab", { name: "report.pdf" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Minimize and reopen: the older tab waits for saved files instead of reporting it gone.
  rerender(<ComputerWorkspace {...view} open={false} selection={null} />);
  mockSavedPage = {
    results: [],
    status: "LoadingFirstPage",
    loadMore: () => {},
  };
  rerender(<ComputerWorkspace {...view} selection={null} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading saved files");
  expect(screen.queryByText(/no longer in this chat/)).not.toBeInTheDocument();
  mockSavedPage = {
    results: [olderReport],
    status: "Exhausted",
    loadMore: () => {},
  };
  rerender(<ComputerWorkspace {...view} selection={null} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Download saved file" }),
  );
  await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
  const [options] = (downloadFile as jest.Mock).mock.calls[0];
  expect(options).toMatchObject({
    filename: "report.pdf",
    mimeType: "application/pdf",
  });
  // The downloader loads bytes only after its save picker has opened.
  expect(mockGetUrl).not.toHaveBeenCalled();
  expect(Array.from(await options.content())).toEqual(Array.from(bytes));
  expect(mockGetUrl).toHaveBeenCalledWith({ fileId: "file-pdf" });
  expect(
    (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url)),
  ).toEqual(["https://signed/report"]);
});

it("keeps two captured versions open, reuses a version, and preserves the selected file through activity updates and minimize", async () => {
  const { rerender } = render(<ComputerWorkspace {...props} />);
  const rows = within(
    screen.getByRole("navigation", { name: "Files in this chat" }),
  ).getAllByRole("button", { name: /report.txt/ });
  fireEvent.click(rows[0]);
  expect(await screen.findByText("desktop historical version")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[1],
  );
  expect(await screen.findByText("cloud historical version")).toBeVisible();
  expect(screen.getAllByRole("tab", { name: "report.txt" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[1],
  );
  expect(screen.getAllByRole("tab", { name: "report.txt" })).toHaveLength(2);
  rerender(<ComputerWorkspace {...props} selection={activity} />);
  expect(screen.getByText("cloud historical version")).toBeVisible();
  rerender(<ComputerWorkspace {...props} open={false} selection={null} />);
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  rerender(<ComputerWorkspace {...props} selection={null} />);
  expect(screen.getByText("cloud historical version")).toBeVisible();
  expect(global.fetch).not.toHaveBeenCalled();
});

it("removes a deleted historical payload immediately instead of retaining cached content", async () => {
  const { rerender } = render(<ComputerWorkspace {...props} />);
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[0],
  );
  expect(await screen.findByText("desktop historical version")).toBeVisible();
  rerender(<ComputerWorkspace {...props} messages={[]} />);
  expect(
    screen.queryByText("desktop historical version"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "no longer in this chat",
  );
});

it("keeps Files discoverable, loads it on selection, and preserves its search through keyboard navigation", () => {
  render(<ComputerWorkspace {...props} selection={activity} />);
  expect(screen.getByRole("tab", { name: "Files" })).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: "Search chat files" }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), {
    key: "ArrowRight",
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Search chat files" }), {
    target: { value: "report" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), {
    key: "ArrowRight",
  });
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByRole("textbox", { name: "Search chat files" }),
  ).toHaveValue("report");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), {
    key: "Delete",
  });
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("retains the loaded workspace bytes when the live file changes and opens the new revision separately", async () => {
  let revision = "one";
  global.fetch = jest.fn().mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () =>
        body.action === "preview"
          ? {
              data: btoa(`version ${revision}`),
              size: 11,
              revision,
              sandboxId: "cloud-owned",
            }
          : {
              state: "running",
              sandboxId: "cloud-owned",
              root: "/home/user",
              environmentLabel: "Cloud",
              entries: [
                { name: "report.txt", kind: "file", size: 11, modified: 1000 },
              ],
              total: 1,
              nextOffset: null,
            },
    };
  });
  render(<ComputerWorkspace {...props} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Workspace", exact: true }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview report.txt" }),
  );
  expect(await screen.findByText("version one")).toBeVisible();
  revision = "two";
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview report.txt" }));
  expect(await screen.findByText("version two")).toBeVisible();
  const fileTabs = screen.getAllByRole("tab", { name: "report.txt" });
  expect(fileTabs).toHaveLength(2);
  fireEvent.click(fileTabs[0]);
  expect(screen.getByText("version one")).toBeVisible();
  expect(screen.getByText("version two")).not.toBeVisible();
  const panel = within(screen.getByRole("tabpanel"));
  expect(panel.getByText("Cloud · Snapshot")).toBeVisible();
  expect(screen.queryByText(/Loaded from Cloud/)).not.toBeInTheDocument();
  fireEvent.click(panel.getByRole("button", { name: "Snapshot details" }));
  const details = await screen.findByRole("dialog", {
    name: "Snapshot details",
  });
  expect(within(details).getByText(/Loaded from Cloud/)).toBeVisible();
  fireEvent.keyDown(details, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "Snapshot details" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("version one")).toBeVisible();
});

it.each(["image", "pdf"] as const)(
  "keeps %s view tool selections in the existing Activity viewer",
  (kind) => {
    const preview = {
      type: "file" as const,
      fileId: "saved-preview",
      filename: "page.png",
      mediaType: "image/png",
      size: 524288,
    };
    const viewMessages = [
      {
        id: "view-message",
        role: "assistant",
        parts: [
          {
            type: "tool-file",
            state: "output-available",
            toolCallId: "view-call",
            input: { action: "view", path: `/report.${kind}` },
            output: { previewFiles: [preview] },
          },
        ],
      },
    ];
    const selection = {
      path: `/report.${kind}`,
      content: "",
      action: "viewing" as const,
      kind,
      toolCallId: "view-call",
      previewFiles: [preview],
    };
    const renderActivity = jest.fn(() => <p>Existing full-size viewer</p>);
    render(
      <ComputerWorkspace
        {...props}
        messages={viewMessages}
        selection={selection}
        renderActivity={renderActivity}
      />,
    );
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Existing full-size viewer")).toBeVisible();
    expect(
      screen.queryByRole("tab", { name: `report.${kind}` }),
    ).not.toBeInTheDocument();
    expect(renderActivity).toHaveBeenLastCalledWith(selection, true);
    expect(mockGetUrl).not.toHaveBeenCalled();
  },
);

it("lets users reach overflowed tabs and disables arrows at the corresponding edge", () => {
  render(<ComputerWorkspace {...props} />);
  const strip = screen.getByRole("tablist", { name: "Computer tabs" });
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 600 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  strip.scrollBy = jest.fn(({ left }: ScrollToOptions) => {
    strip.scrollLeft += left ?? 0;
    fireEvent.scroll(strip);
  });
  fireEvent.scroll(strip);
  expect(
    screen.getByRole("button", { name: "Scroll tabs left" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Scroll tabs right" }));
  expect(strip.scrollLeft).toBeGreaterThan(0);
  expect(
    screen.getByRole("button", { name: "Scroll tabs left" }),
  ).toBeEnabled();
  strip.scrollLeft = 400;
  fireEvent.scroll(strip);
  expect(
    screen.getByRole("button", { name: "Scroll tabs right" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Scroll tabs left" }));
  expect(strip.scrollLeft).toBeLessThan(400);
});

it("uses direct tabs and a clear close action in the wider overlay", async () => {
  mockOverlay = true;
  const onClose = jest.fn();
  render(<ComputerWorkspace {...props} onClose={onClose} />);
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[0],
  );
  expect(await screen.findByText("desktop historical version")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close Computer" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("returns from a phone preview to the same Files view and reopens the retained preview", async () => {
  mockOverlay = true;
  mockPhone = true;
  render(<ComputerWorkspace {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search chat files" }), {
    target: { value: "report" },
  });
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[0],
  );
  expect(await screen.findByText("desktop historical version")).toBeVisible();
  const back = screen.getByRole("button", { name: "Back to Files" });
  expect(back).toHaveFocus();
  fireEvent.click(back);
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByRole("textbox", { name: "Search chat files" }),
  ).toHaveValue("report");
  expect(screen.getByText("desktop historical version")).not.toBeVisible();
  fireEvent.keyDown(screen.getByRole("button", { name: /Open previews/ }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: /report\.txt/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Back to Files" })).toHaveFocus(),
  );
  expect(screen.getByText("desktop historical version")).toBeVisible();
});

it("returns each explicit Files open to This chat while keeping Activity, opened tabs and background updates intact", async () => {
  const source = (name: "This chat" | "Workspace") =>
    screen.getByRole("button", { name, exact: true });
  const view = { ...props, selection: activity };
  const { rerender } = render(<ComputerWorkspace {...view} />);
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[0],
  );
  expect(await screen.findByText("desktop historical version")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(source("Workspace"));
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

  // Header shortcut from Activity, with Workspace previously chosen.
  rerender(<ComputerWorkspace {...view} selection={files} openRequest={2} />);
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(source("This chat")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("tab", { name: "report.txt" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();

  // A background Activity update is not an open request: the source stays.
  fireEvent.click(source("Workspace"));
  rerender(<ComputerWorkspace {...view} openRequest={2} />);
  expect(source("Workspace")).toHaveAttribute("aria-pressed", "true");

  // Repeating the shortcut while already on Files returns to This chat.
  rerender(<ComputerWorkspace {...view} selection={files} openRequest={3} />);
  expect(source("This chat")).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByText("Latest activity")).toBeVisible();
});

it("clears a deleted Activity entry without dismissing the selected Files tab", () => {
  const renderActivity = jest.fn((content: SidebarContent | null) => (
    <p>{content ? "Retained tool" : "No activity"}</p>
  ));
  const { rerender } = render(
    <ComputerWorkspace
      {...props}
      messages={[]}
      selection={activity}
      renderActivity={renderActivity}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  rerender(
    <ComputerWorkspace
      {...props}
      messages={[]}
      selection={null}
      renderActivity={renderActivity}
    />,
  );
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  expect(
    screen.getByText("Agent activity appears here when tools run."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Retained tool")).not.toBeInTheDocument();
});

it("saves retained binary workspace bytes through native Save after the workspace goes offline", async () => {
  mockNative = true;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:qa-image");
  URL.revokeObjectURL = jest.fn();
  (downloadFile as jest.Mock)
    .mockClear()
    .mockResolvedValue({ outcome: "success" });
  global.fetch = jest.fn().mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () =>
        body.action === "preview"
          ? {
              data: btoa(String.fromCharCode(...bytes)),
              size: bytes.length,
              revision: "image-v1",
              sandboxId: "cloud-owned",
            }
          : {
              state: "running",
              sandboxId: "cloud-owned",
              root: "/home/user",
              environmentLabel: "Cloud",
              entries: [
                {
                  name: "evidence.png",
                  kind: "file",
                  size: bytes.length,
                  modified: 1000,
                },
              ],
              total: 1,
              nextOffset: null,
            },
    };
  });
  const view = render(<ComputerWorkspace {...props} />);
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Workspace", exact: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview evidence.png" }),
    );
    const download = await screen.findByRole("button", {
      name: "Download previewed file",
    });
    global.fetch = jest.fn().mockRejectedValue(new Error("workspace offline"));
    fireEvent.click(download);
    await waitFor(() =>
      expect(downloadFile).toHaveBeenCalledWith({
        filename: "evidence.png",
        content: bytes,
      }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Binary downloads are available in the web app/),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(tracked("workspace_file_download")).toEqual([
        {
          outcome: "success",
          source: "workspace",
          file_kind: "workspace_snapshot",
          entry_point: "computer_files",
          telemetry_version: 1,
          surface: "desktop",
          duration_ms: expect.any(Number),
        },
      ]),
    );
    expect(tracked("workspace_file_preview")).toEqual([
      expect.objectContaining({
        outcome: "success",
        file_kind: "live_workspace",
        entry_point: "computer_files",
      }),
    ]);
  } finally {
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
