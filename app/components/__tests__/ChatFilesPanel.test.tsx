import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatFilesPanel, CapturedFilePreview } from "../ChatFilesPanel";
import { collectChatFiles } from "@/lib/workspace-preview/chat-files";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import { WORKSPACE_DOWNLOAD_LIMIT } from "@/lib/sandbox/workspace-files";
const tracked = (event: string) =>
  (captureQueuedAuthenticatedEvent as jest.Mock).mock.calls
    .filter(([call]) => call.event === event)
    .map(([call]) => call.properties);
const savedDownload = (outcome: string, surface: string) => ({
  outcome,
  source: "chat",
  file_kind: "saved_attachment",
  entry_point: "other",
  telemetry_version: 1,
  surface,
  duration_ms: expect.any(Number),
});
const getUrl = jest.fn();
const mockSaveBinary = jest.fn();
const mockSaveText = jest.fn();
let mockTauri = false;
jest.mock("convex/react", () => ({ useAction: () => getUrl }));
jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(() => true),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
// The real shared downloader runs; only the native save dialog is replaced.
jest.mock("../../hooks/useTauri", () => ({
  isTauriEnvironment: () => mockTauri,
  saveFileToLocal: (...args: unknown[]) => mockSaveText(...args),
  saveBinaryFileToLocal: (...args: unknown[]) => mockSaveBinary(...args),
  revealFileInDir: jest.fn(),
}));
// %PDF followed by bytes that are invalid UTF-8 and a NUL.
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe]);
const bytesResponse = (bytes: Uint8Array) => ({
  ok: true,
  headers: { get: () => String(bytes.length) },
  body: {
    getReader: () => {
      let sent = false;
      return {
        read: async () =>
          sent
            ? { done: true }
            : ((sent = true), { done: false, value: bytes }),
        cancel: async () => {},
      };
    },
  },
});
const expiredResponse = { ok: false, headers: { get: () => null }, body: null };
/** Persisted history: the assistant delivered a PDF; no workspace is reachable. */
const persistedReport = JSON.stringify([
  {
    id: "m-report",
    role: "assistant",
    parts: [{ type: "text", text: "Report ready" }],
    fileDetails: [
      {
        fileId: "file-pdf",
        name: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: pdfBytes.length,
      },
    ],
  },
]);
const signedOnlyFetch = (responses: Record<string, unknown>) =>
  jest.fn(async (url: string) => {
    if (url in responses) return responses[url];
    throw new Error("workspace offline");
  });
const fetchedUrls = () =>
  (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
const openPersistedReport = async () => {
  const { unmount } = render(
    <ChatFilesPanel messages={JSON.parse(persistedReport)} />,
  );
  unmount();
  render(<ChatFilesPanel messages={JSON.parse(persistedReport)} />);
  fireEvent.click(screen.getByRole("button", { name: /report\.pdf/ }));
  return screen.findByRole("button", { name: "Download saved file" });
};
afterEach(() => {
  mockTauri = false;
  mockSaveBinary.mockReset();
  mockSaveText.mockReset();
  (captureQueuedAuthenticatedEvent as jest.Mock).mockClear();
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});
const messages = ["cloud", "desktop"].map((environment, index) => ({
  id: `m${index}`,
  role: "assistant",
  parts: [
    {
      type: "tool-file",
      state: "output-available",
      toolCallId: `call${index}`,
      input: {
        path: "/reports/report.txt",
        action: "read",
        ...(index ? { range: [20, 80] } : {}),
      },
      output: {
        originalContent: `${environment} saved content`,
        fileSnapshot: {
          environment,
          identity: environment,
          capturedAt: 100 + index,
        },
      },
    },
  ],
}));
beforeEach(() => {
  getUrl.mockReset();
  global.fetch = jest
    .fn()
    .mockRejectedValue(new Error("all environments disconnected"));
});
it("opens each captured version without fetching a workspace, including after reload", async () => {
  const { unmount } = render(
    <ChatFilesPanel messages={JSON.parse(JSON.stringify(messages))} />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: /report.txt/ })[0]);
  expect(await screen.findByText("desktop saved content")).toBeVisible();
  expect(screen.getByLabelText("Download captured excerpt")).toBeVisible();
  expect(
    screen.getByText(/Captured excerpt · This is not the complete file/),
  ).toBeVisible();
  expect(
    screen.queryByText(/Saved with this tool result/),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Captured file details" }),
  );
  expect(await screen.findByText(/Saved with this tool result/)).toBeVisible();
  fireEvent.keyDown(
    screen.getByRole("dialog", { name: "Captured file details" }),
    { key: "Escape" },
  );
  fireEvent.click(screen.getByLabelText("Close file preview"));
  fireEvent.click(screen.getAllByRole("button", { name: /report.txt/ })[1]);
  expect(await screen.findByText("cloud saved content")).toBeVisible();
  expect(global.fetch).not.toHaveBeenCalled();
  unmount();
  render(<ChatFilesPanel messages={JSON.parse(JSON.stringify(messages))} />);
  expect(screen.getAllByRole("button", { name: /report.txt/ })).toHaveLength(2);
});
it("changes exact tool-call content without retaining the previous preview", async () => {
  const files = collectChatFiles(messages);
  const { rerender } = render(
    <CapturedFilePreview file={files[0]} onClose={() => {}} />,
  );
  expect(await screen.findByText("cloud saved content")).toBeVisible();
  rerender(<CapturedFilePreview file={files[1]} onClose={() => {}} />);
  expect(await screen.findByText("desktop saved content")).toBeVisible();
  expect(screen.queryByText("cloud saved content")).not.toBeInTheDocument();
});
it("does not fall back to the current environment when stored content is gone", async () => {
  getUrl.mockResolvedValue(null);
  const [file] = collectChatFiles([
    {
      id: "m",
      role: "assistant",
      fileDetails: [{ fileId: "stored", name: "gone.txt" }],
    },
  ]);
  render(<CapturedFilePreview file={file} onClose={() => {}} />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved file is unavailable",
    ),
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

it("saves exact stored binary bytes on Desktop after reopening with every workspace offline", async () => {
  mockTauri = true;
  mockSaveBinary.mockResolvedValue("/Users/me/report.pdf");
  getUrl.mockResolvedValue("https://signed/report");
  global.fetch = signedOnlyFetch({
    "https://signed/report": bytesResponse(pdfBytes),
  }) as unknown as typeof fetch;
  fireEvent.click(await openPersistedReport());
  await waitFor(() => expect(mockSaveBinary).toHaveBeenCalledTimes(1));
  const [filename, content] = mockSaveBinary.mock.calls[0];
  expect(filename).toBe("report.pdf");
  expect(content).toBeInstanceOf(Uint8Array);
  expect(Array.from(content)).toEqual(Array.from(pdfBytes));
  expect(mockSaveText).not.toHaveBeenCalled();
  expect(getUrl).toHaveBeenCalledWith({ fileId: "file-pdf" });
  expect(fetchedUrls()).toEqual(["https://signed/report"]);
  expect(tracked("workspace_file_download")).toEqual([
    savedDownload("success", "desktop"),
  ]);
  // A PDF has no in-app preview; an unsupported format is not a failed read.
  expect(tracked("workspace_file_preview")).toEqual([]);
});

it("resolves a fresh signed URL on each click instead of retrying an expired one", async () => {
  const write = jest.fn();
  (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = jest.fn(
    async () => ({
      createWritable: async () => ({ write, close: jest.fn() }),
    }),
  );
  getUrl
    .mockResolvedValueOnce("https://signed/expired")
    .mockResolvedValueOnce("https://signed/fresh");
  global.fetch = signedOnlyFetch({
    "https://signed/expired": expiredResponse,
    "https://signed/fresh": bytesResponse(pdfBytes),
  }) as unknown as typeof fetch;
  const button = await openPersistedReport();
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved file is unavailable.",
    ),
  );
  expect(tracked("workspace_file_download")).toEqual([
    savedDownload("failed", "web"),
  ]);
  fireEvent.click(button);
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(Array.from(write.mock.calls[0][0])).toEqual(Array.from(pdfBytes));
  expect(fetchedUrls()).toEqual([
    "https://signed/expired",
    "https://signed/fresh",
  ]);
  expect(getUrl).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(screen.queryByRole("status")).not.toBeInTheDocument(),
  );
  expect(tracked("workspace_file_download")).toEqual([
    savedDownload("failed", "web"),
    savedDownload("success", "web"),
  ]);
});

it("opens the browser picker before any network work and skips it entirely when canceled", async () => {
  const picker = jest.fn(async () => {
    throw new DOMException("canceled", "AbortError");
  });
  (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
  getUrl.mockResolvedValue("https://signed/report");
  global.fetch = signedOnlyFetch({
    "https://signed/report": bytesResponse(pdfBytes),
  }) as unknown as typeof fetch;
  fireEvent.click(await openPersistedReport());
  await waitFor(() =>
    expect(tracked("workspace_file_download")).toEqual([
      savedDownload("canceled", "web"),
    ]),
  );
  expect(picker).toHaveBeenCalledTimes(1);
  expect(getUrl).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();

  // A chosen destination then resolves the signed URL and transfers the bytes.
  const write = jest.fn();
  picker.mockImplementationOnce(
    async () =>
      ({
        createWritable: async () => ({ write, close: jest.fn() }),
      }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download saved file" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(picker.mock.invocationCallOrder[1]).toBeLessThan(
    getUrl.mock.invocationCallOrder[0],
  );
  expect(Array.from(write.mock.calls[0][0])).toEqual(Array.from(pdfBytes));
});

it.each([
  ["canceled", () => mockSaveBinary.mockResolvedValue(null), null, undefined],
  [
    "failed",
    () => mockSaveBinary.mockRejectedValue("disk full"),
    "The file could not be saved. Try again.",
    undefined,
  ],
  [
    "failed",
    () =>
      mockSaveBinary.mockRejectedValue(
        "command save_binary_file_with_dialog not found",
      ),
    "Update HackerAI Desktop to save this file, then try again.",
    "unsupported_native",
  ],
] as const)(
  "reports a %s native save without claiming success",
  async (outcome, arrange, message, reason) => {
    mockTauri = true;
    arrange();
    getUrl.mockResolvedValue("https://signed/report");
    global.fetch = signedOnlyFetch({
      "https://signed/report": bytesResponse(pdfBytes),
    }) as unknown as typeof fetch;
    const button = await openPersistedReport();
    fireEvent.click(button);
    await waitFor(() =>
      expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledTimes(1),
    );
    expect(tracked("workspace_file_download")).toEqual([
      { ...savedDownload(outcome, "desktop"), ...(reason && { reason }) },
    ]);
    if (message) expect(screen.getByRole("status")).toHaveTextContent(message);
    else expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  },
);

it.each([
  [
    "oversized",
    { ok: true, length: WORKSPACE_DOWNLOAD_LIMIT + 1 },
    "File exceeds the size limit for this action.",
  ],
  ["rejected", { ok: false, length: 10 }, "Saved file is unavailable."],
] as const)(
  "cancels a %s saved-file body and keeps the user-facing reason",
  async (_case, { ok, length }, message) => {
    mockTauri = true;
    // Cleanup failure must not replace the reason shown to the user.
    const cancel = jest.fn(async () => {
      throw new Error("cancel failed");
    });
    const getReader = jest.fn();
    getUrl.mockResolvedValue("https://signed/report");
    global.fetch = signedOnlyFetch({
      "https://signed/report": {
        ok,
        headers: { get: () => String(length) },
        body: { cancel, getReader },
      },
    }) as unknown as typeof fetch;
    fireEvent.click(await openPersistedReport());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(message),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(mockSaveBinary).not.toHaveBeenCalled();
  },
);

it("still reads a saved file whose declared size equals the limit", async () => {
  mockTauri = true;
  mockSaveBinary.mockResolvedValue("/Users/me/report.pdf");
  getUrl.mockResolvedValue("https://signed/report");
  global.fetch = signedOnlyFetch({
    "https://signed/report": {
      ...bytesResponse(pdfBytes),
      headers: { get: () => String(WORKSPACE_DOWNLOAD_LIMIT) },
    },
  }) as unknown as typeof fetch;
  fireEvent.click(await openPersistedReport());
  await waitFor(() => expect(mockSaveBinary).toHaveBeenCalledTimes(1));
  expect(Array.from(mockSaveBinary.mock.calls[0][1])).toEqual(
    Array.from(pdfBytes),
  );
});

it("keeps text captures as text and names excerpts as excerpts on Desktop", async () => {
  mockTauri = true;
  mockSaveText.mockResolvedValue("/Users/me/report.txt.excerpt.txt");
  const [, excerpt] = collectChatFiles(messages);
  render(<CapturedFilePreview file={excerpt} onClose={() => {}} />);
  fireEvent.click(screen.getByLabelText("Download captured excerpt"));
  await waitFor(() =>
    expect(mockSaveText).toHaveBeenCalledWith(
      "report.txt.excerpt.txt",
      "desktop saved content",
    ),
  );
  expect(mockSaveBinary).not.toHaveBeenCalled();
  expect(getUrl).not.toHaveBeenCalled();
});

it("reports a saved preview once, only after it settles in a visible Files tab", async () => {
  const text = Uint8Array.from("saved notes", (c) => c.charCodeAt(0));
  getUrl.mockResolvedValue("https://signed/notes");
  global.fetch = signedOnlyFetch({
    "https://signed/notes": bytesResponse(text),
  }) as unknown as typeof fetch;
  const [saved] = collectChatFiles([
    {
      id: "m",
      role: "assistant",
      fileDetails: [{ fileId: "notes", name: "notes.txt" }],
    },
  ]);
  const { rerender } = render(
    <CapturedFilePreview file={saved} onClose={() => {}} visible={false} />,
  );
  expect(await screen.findByText("saved notes")).toBeInTheDocument();
  // Loaded in a background tab: not yet a preview the user saw.
  expect(tracked("workspace_file_preview")).toEqual([]);
  rerender(<CapturedFilePreview file={saved} onClose={() => {}} visible />);
  rerender(
    <CapturedFilePreview file={saved} onClose={() => {}} visible={false} />,
  );
  rerender(<CapturedFilePreview file={saved} onClose={() => {}} visible />);
  expect(tracked("workspace_file_preview")).toEqual([
    {
      outcome: "success",
      file_kind: "saved_attachment",
      entry_point: "computer_files",
      telemetry_version: 1,
      surface: "web",
      duration_ms: expect.any(Number),
    },
  ]);
});

it("separates captured results, unavailable stored files and untracked viewers", async () => {
  const [captured] = collectChatFiles(messages);
  const { unmount } = render(
    <CapturedFilePreview file={captured} onClose={() => {}} visible />,
  );
  expect(await screen.findByText("cloud saved content")).toBeVisible();
  // Captured text has no load to time.
  expect(tracked("workspace_file_preview")).toEqual([
    {
      outcome: "success",
      file_kind: "captured_result",
      entry_point: "computer_files",
      telemetry_version: 1,
      surface: "web",
    },
  ]);
  unmount();

  getUrl.mockResolvedValue(null);
  const [gone] = collectChatFiles([
    {
      id: "m",
      role: "assistant",
      fileDetails: [{ fileId: "stored", name: "gone.txt" }],
    },
  ]);
  const view = render(
    <CapturedFilePreview file={gone} onClose={() => {}} visible />,
  );
  await waitFor(() =>
    expect(tracked("workspace_file_preview")).toHaveLength(2),
  );
  expect(tracked("workspace_file_preview")[1]).toMatchObject({
    outcome: "unavailable",
    file_kind: "saved_attachment",
  });
  view.unmount();

  // Activity and standalone viewers omit `visible` and report no previews.
  render(<CapturedFilePreview file={captured} onClose={() => {}} />);
  expect(await screen.findByText("cloud saved content")).toBeVisible();
  expect(tracked("workspace_file_preview")).toHaveLength(2);
});
