import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatFilesPanel, CapturedFilePreview } from "../ChatFilesPanel";
import { collectChatFiles } from "@/lib/workspace-preview/chat-files";
const getUrl = jest.fn();
jest.mock("convex/react", () => ({ useAction: () => getUrl }));
jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("@/lib/utils/file-download", () => ({ downloadFile: jest.fn() }));
jest.mock("../../hooks/useTauri", () => ({ isTauriEnvironment: () => false }));
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
