import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LiveWorkspaceFilesPanel as WorkspaceFilesPanel } from "../WorkspaceFilesPanel";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import { downloadFile } from "@/lib/utils/file-download";
let mockNative = false;
const tracked = (event: string) =>
  (captureQueuedAuthenticatedEvent as jest.Mock).mock.calls
    .filter(([call]) => call.event === event)
    .map(([call]) => call.properties);
const liveEvent = (properties: Record<string, unknown>) => ({
  file_kind: "live_workspace",
  entry_point: "other",
  telemetry_version: 1,
  duration_ms: expect.any(Number),
  ...properties,
});

jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(() => true),
}));
jest.mock("../AllFilesDialog", () => ({
  AllFilesDialog: () => <div>Saved artifacts dialog</div>,
}));
jest.mock("@/lib/utils/file-download", () => ({ downloadFile: jest.fn() }));
jest.mock("../../hooks/useTauri", () => ({
  isTauriEnvironment: () => mockNative,
}));

const fetchMock = jest.fn();
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });
const listing = (entries: unknown[]) => ({
  state: "running",
  sandboxId: "owned",
  entries,
  total: entries.length,
  nextOffset: null,
});
const folder = { name: "reports", kind: "directory", size: 0, modified: 1000 };
const file = { name: "report.txt", kind: "file", size: 5, modified: 1000 };
beforeEach(() => {
  mockNative = false;
  global.fetch = fetchMock;
  fetchMock.mockReset();
  (captureQueuedAuthenticatedEvent as jest.Mock).mockClear();
  (downloadFile as jest.Mock).mockReset();
});

it("navigates, searches and refreshes the pinned live workspace, then previews escaped text", async () => {
  fetchMock.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "preview")
      return response({
        state: "running",
        sandboxId: "owned",
        data: btoa("<script>alert(1)</script>"),
        size: 25,
      });
    return response(listing(body.path === "reports" ? [file] : [folder]));
  });
  await act(async () => {
    render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Open folder reports" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview report.txt" }),
  );
  expect(await screen.findByText("<script>alert(1)</script>")).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search this folder"), {
    target: { value: "report" },
  });
  await waitFor(() =>
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body)).toMatchObject({
      path: "reports",
      search: "report",
      sandboxId: "owned",
    }),
  );
  fireEvent.click(screen.getByLabelText("Refresh workspace files"));
  await screen.findByRole("button", { name: "Preview report.txt" });
  fireEvent.click(screen.getByRole("button", { name: "Parent folder" }));
  expect(
    await screen.findByRole("button", { name: "Open folder reports" }),
  ).toBeVisible();
  // Visibility is reported by the Computer workspace, not by this mount.
  expect(tracked("workspace_files_viewed")).toEqual([]);
  expect(tracked("workspace_file_preview")).toEqual([
    liveEvent({ outcome: "success", surface: "web" }),
  ]);
});

it("offers explicit resume for a paused workspace and keeps saved artifacts accessible", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ state: "paused", sandboxId: "owned" }))
    .mockResolvedValueOnce(response(listing([file])));
  await act(async () => {
    render(
      <WorkspaceFilesPanel
        chatId="chat"
        messages={[
          { id: "saved", fileDetails: [{ name: "report.txt", sizeBytes: 5 }] },
        ]}
      />,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Resume workspace" }),
  );
  expect(
    await screen.findByRole("button", { name: "Preview report.txt" }),
  ).toBeVisible();
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
    action: "resume",
    sandboxId: "owned",
  });
  fireEvent.click(screen.getByRole("button", { name: "Saved chat files (1)" }));
  expect(screen.getByText("Saved artifacts dialog")).toBeVisible();
});

it("recovers a disconnected listing by refresh without displaying stale entries", async () => {
  fetchMock
    .mockResolvedValueOnce(response(listing([file])))
    .mockResolvedValueOnce(response({ error: "workspace_unavailable" }, false))
    .mockResolvedValueOnce(response(listing([folder])));
  await act(async () => {
    render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  await screen.findByRole("button", { name: "Preview report.txt" });
  fireEvent.click(screen.getByLabelText("Refresh workspace files"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Workspace unavailable",
  );
  expect(
    screen.queryByRole("button", { name: "Preview report.txt" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Refresh workspace files"));
  expect(
    await screen.findByRole("button", { name: "Open folder reports" }),
  ).toBeVisible();
});

it("aborts an in-flight preview when navigating away and never displays its late result", async () => {
  let resolvePreview: (value: unknown) => void = () => {};
  fetchMock.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "preview")
      return new Promise((resolve) => {
        resolvePreview = resolve;
      });
    return response(listing(body.path === "reports" ? [file] : [folder]));
  });
  await act(async () => {
    render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Open folder reports" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview report.txt" }),
  );
  fireEvent.click(screen.getByLabelText("Parent folder"));
  await screen.findByRole("button", { name: "Open folder reports" });
  await act(async () =>
    resolvePreview(response({ data: btoa("OLD PREVIEW") })),
  );
  expect(screen.queryByText("OLD PREVIEW")).not.toBeInTheDocument();
  // An intentional abort is neither a success nor a failure.
  expect(tracked("workspace_file_preview")).toEqual([]);
});

it.each(["Tree view", "List view", "Grid view"])(
  "explains size limits only on affected files in %s",
  async (view) => {
    fetchMock.mockResolvedValue(
      response(
        listing([
          file,
          { ...file, name: "large.txt", size: 300 * 1024 },
          { ...file, name: "huge.txt", size: 51 * 1024 * 1024 },
        ]),
      ),
    );
    render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
    await screen.findByRole("button", { name: "Preview report.txt" });
    fireEvent.click(screen.getByRole("button", { name: view }));
    expect(
      await screen.findByText("Too large to preview · Download available"),
    ).toBeVisible();
    expect(screen.getByText("Exceeds 50 MB download limit")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Download large.txt" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Download huge.txt" }),
    ).toBeDisabled();
    expect(screen.queryByText(/Preview ≤256 KB/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Live files can change/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Workspace details" }));
    expect(await screen.findByText(/Live files can change/)).toBeVisible();
  },
);

it("keeps refresh and layout choices usable through the compact file menu", async () => {
  fetchMock.mockResolvedValue(response(listing([file])));
  render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
  await screen.findByRole("button", { name: "Preview report.txt" });
  expect(
    screen.queryByRole("button", { name: /Saved chat files/ }),
  ).not.toBeInTheDocument();
  const openOptions = async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: "File options" }), {
      key: "Enter",
    });
    return await screen.findByRole("menu");
  };
  const menu = await openOptions();
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Preview report.txt" }),
  ).toBeVisible();
  await openOptions();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "List", exact: true }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Search this folder" }),
  ).toBeVisible();
  await openOptions();
  expect(
    screen.getByRole("menuitemradio", { name: "List", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  fetchMock.mockResolvedValue(response(listing([folder])));
  fireEvent.click(screen.getByRole("menuitem", { name: "Refresh files" }));
  expect(
    await screen.findByRole("button", { name: "Open folder reports" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Preview report.txt" }),
  ).not.toBeInTheDocument();
  await openOptions();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Folder tree" }));
  expect(
    await screen.findByRole("navigation", { name: "Workspace file tree" }),
  ).toBeVisible();
});

it("passes exact chunked binary bytes to native Save and preserves cancellation", async () => {
  mockNative = true;
  const bytes = new Uint8Array([0x50, 0x4b, 0xff, 0x00]);
  (downloadFile as jest.Mock).mockResolvedValue({ outcome: "canceled" });
  fetchMock.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action !== "download")
      return response(
        listing([{ ...file, name: "export.zip", size: bytes.length }]),
      );
    const offset = body.byteOffset ?? 0;
    return response({
      data: btoa(String.fromCharCode(...bytes.slice(offset, offset + 2))),
      size: bytes.length,
      revision: "zip-v1",
      sandboxId: "owned",
      nextByteOffset: offset === 0 ? 2 : null,
    });
  });
  render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Download export.zip" }),
  );
  await waitFor(() =>
    expect(downloadFile).toHaveBeenCalledWith({
      filename: "export.zip",
      content: bytes,
    }),
  );
  expect(tracked("workspace_file_download")).toEqual([
    liveEvent({ outcome: "canceled", source: "workspace", surface: "desktop" }),
  ]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  [
    "a rejected read",
    response({ error: "file_changed" }, false),
    { outcome: "failed" },
  ],
  [
    "a status without bytes",
    response({ state: "disconnected", sandboxId: "owned" }),
    { outcome: "failed", reason: "unavailable" },
  ],
])(
  "reports %s as a failed download without invoking the save",
  async (_case, downloadResponse, expected) => {
    fetchMock.mockImplementation(async (_url, options) =>
      JSON.parse(options.body).action === "download"
        ? downloadResponse
        : response(listing([file])),
    );
    render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Download report.txt" }),
    );
    await waitFor(() =>
      expect(tracked("workspace_file_download")).toEqual([
        liveEvent({ ...expected, source: "workspace", surface: "web" }),
      ]),
    );
    expect(downloadFile).not.toHaveBeenCalled();
  },
);

it("reports a browser anchor download as initiated, not as a confirmed save", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:live");
  URL.revokeObjectURL = jest.fn();
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  fetchMock.mockImplementation(async (_url, options) =>
    JSON.parse(options.body).action === "download"
      ? response({ data: btoa("hello"), size: 5, revision: "r1" })
      : response(listing([file])),
  );
  try {
    render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Download report.txt" }),
    );
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(tracked("workspace_file_download")).toEqual([
      liveEvent({ outcome: "initiated", source: "workspace", surface: "web" }),
    ]);
  } finally {
    click.mockRestore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

it.each([
  [
    "unavailable for a status without bytes",
    response({ state: "disconnected", sandboxId: "owned" }),
    [liveEvent({ outcome: "unavailable", surface: "web" })],
  ],
  [
    "failed for a rejected read",
    response({ error: "rate_limited" }, false),
    [liveEvent({ outcome: "failed", surface: "web" })],
  ],
  [
    "nothing for an unsupported binary format",
    response({ data: btoa("\u0000\u0001"), size: 2, revision: "r1" }),
    [],
  ],
])("reports a live preview as %s", async (_case, previewResponse, expected) => {
  fetchMock.mockImplementation(async (_url, options) =>
    JSON.parse(options.body).action === "preview"
      ? previewResponse
      : response(listing([{ ...file, name: "notes" }])),
  );
  render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  fireEvent.click(await screen.findByRole("button", { name: "Preview notes" }));
  // The read has settled once the file request is no longer busy.
  await waitFor(() =>
    expect(document.querySelector('[aria-busy="true"]')).toBeNull(),
  );
  expect(tracked("workspace_file_preview")).toEqual(expected);
});
