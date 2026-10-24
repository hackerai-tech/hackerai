import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LiveWorkspaceFilesPanel as WorkspaceFilesPanel } from "../WorkspaceFilesPanel";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";

jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("../AllFilesDialog", () => ({
  AllFilesDialog: () => <div>Saved artifacts dialog</div>,
}));
jest.mock("@/lib/utils/file-download", () => ({ downloadFile: jest.fn() }));
jest.mock("../../hooks/useTauri", () => ({ isTauriEnvironment: () => false }));

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
  global.fetch = fetchMock;
  fetchMock.mockReset();
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
  expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
    "workspace_files_viewed",
  );
});

it("offers explicit resume for a paused workspace and keeps saved artifacts accessible", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ state: "paused", sandboxId: "owned" }))
    .mockResolvedValueOnce(response(listing([file])));
  await act(async () => {
    render(<WorkspaceFilesPanel chatId="chat" messages={[]} />);
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
  fireEvent.click(screen.getByRole("button", { name: "Saved chat files (0)" }));
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
});
