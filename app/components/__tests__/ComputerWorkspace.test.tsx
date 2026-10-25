import { fireEvent, render, screen, within } from "@testing-library/react";
import { ComputerWorkspace } from "../ComputerWorkspace";
import type { SidebarContent } from "@/types/chat";

const mockGetUrl = jest.fn();
jest.mock("convex/react", () => ({ useAction: () => mockGetUrl }));
jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("../../contexts/GlobalState", () => ({
  useGlobalState: () => ({ sandboxPreference: "cloud" }),
}));
jest.mock("@/hooks/use-workspace-layout", () => ({
  useComputerSidebarOverlay: () => false,
}));
jest.mock("../AllFilesDialog", () => ({ AllFilesDialog: () => null }));
jest.mock("../../hooks/useTauri", () => ({ isTauriEnvironment: () => false }));
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
  global.fetch = jest.fn().mockRejectedValue(new Error("offline"));
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

it("keeps Files discoverable, loads it on selection, and preserves its search through keyboard navigation", async () => {
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
  fireEvent.keyDown(screen.getByRole("button", { name: "Open computer tab" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  expect(screen.getAllByRole("tab", { name: "Files" })).toHaveLength(1);
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

it("opens the compact menu without replacing the preview and dismisses it without closing Computer", async () => {
  const onClose = jest.fn();
  render(<ComputerWorkspace {...props} onClose={onClose} />);
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Files in this chat" }),
    ).getAllByRole("button", { name: /report.txt/ })[0],
  );
  expect(await screen.findByText("desktop historical version")).toBeVisible();
  fireEvent.keyDown(screen.getByRole("button", { name: "Open computer tab" }), {
    key: "Enter",
  });
  const item = await screen.findByRole("menuitem", { name: "Files" });
  expect(screen.getByText("desktop historical version")).toBeVisible();
  fireEvent.keyDown(item, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "report.txt" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
