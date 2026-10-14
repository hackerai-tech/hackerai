import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MySkills } from "../MySkills";

let mockUserId = "";
let mockAuthenticated = true;
let mockSelection: unknown[] = [];
const mockSave = jest.fn();
const mockGet = jest.fn();
const mockDownload = jest.fn();
const mockSelect = jest.fn();
const mockCapture = jest.fn();
const mockLibrary = [
  {
    id: "skill-1",
    name: "API review",
    description: "For APIs",
    isDefault: true,
  },
];
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: mockUserId } }),
}));
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: mockAuthenticated }),
  useConvex: () => ({ query: mockGet }),
  useQuery: (name: string) => (name === "list" ? mockLibrary : mockSelection),
  useMutation: (name: string) =>
    name === "save" ? mockSave : name === "select" ? mockSelect : jest.fn(),
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    userSkills: {
      list: "list",
      selection: "selection",
      save: "save",
      select: "select",
    },
  },
}));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));

jest.mock("@/lib/utils/file-download", () => ({
  downloadFile: (...args: unknown[]) => mockDownload(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUserId = crypto.randomUUID();
  mockAuthenticated = true;
  mockSelection = [];
  mockSave.mockResolvedValue("new-skill");
  mockSelect.mockResolvedValue(null);
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
});

it("waits for Convex authentication before exposing skills or requesting access", async () => {
  mockAuthenticated = false;
  const { rerender } = render(<MySkills chatId="chat-1" />);
  expect(screen.queryByRole("button", { name: "Manage skills" })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  mockAuthenticated = true;
  rerender(<MySkills chatId="chat-1" />);
  expect(
    await screen.findByRole("button", { name: "Manage skills" }),
  ).toBeVisible();
});

it("requires review and explicit save for conversation text", async () => {
  render(<MySkills conversationText="Private draft methodology" />);
  fireEvent.click(await screen.findByRole("button", { name: "Save as skill" }));
  expect(screen.getByLabelText("Methodology (Markdown)")).toHaveValue(
    "Private draft methodology",
  );
  expect(mockSave).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Reviewed workflow" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save skill", exact: true }),
  );
  await waitFor(() =>
    expect(mockSave).toHaveBeenCalledWith({
      name: "Reviewed workflow",
      description: "",
      content: "Private draft methodology",
    }),
  );
  expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(
    "Private draft methodology",
  );
  expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(
    "Reviewed workflow",
  );
});

it("manages new-chat defaults separately from the composer's selection", async () => {
  render(<MySkills />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage skills" }));
  expect(
    screen.queryByRole("checkbox", { name: "Use in this chat" }),
  ).toBeNull();
  expect(
    screen.getByRole("checkbox", { name: "Default for new chats" }),
  ).toBeChecked();
  expect(mockSelect).not.toHaveBeenCalled();
});

it("imports Markdown into the same review flow without saving automatically", async () => {
  render(<MySkills chatId="chat-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage skills" }));
  const file = new File(["placeholder"], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () =>
      new TextEncoder().encode(
        "---\nname: Imported API review\ndescription: For API tests\n---\n\nCompare authorized accounts.",
      ).buffer,
  });
  fireEvent.change(screen.getByLabelText("Upload skill Markdown"), {
    target: { files: [file] },
  });
  expect(await screen.findByLabelText("Name")).toHaveValue(
    "Imported API review",
  );
  expect(screen.getByLabelText("When to use it")).toHaveValue("For API tests");
  expect(screen.getByLabelText("Methodology (Markdown)")).toHaveValue(
    "Compare authorized accounts.",
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it("exports through the shared native/browser save flow and handles cancellation", async () => {
  mockGet.mockResolvedValue({
    name: "API review",
    description: "For APIs",
    content: "Compare accounts.",
  });
  mockDownload.mockResolvedValue({ outcome: "canceled" });
  render(<MySkills chatId="chat-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage skills" }));
  fireEvent.click(screen.getByRole("button", { name: "Export API review" }));
  await waitFor(() =>
    expect(mockDownload).toHaveBeenCalledWith({
      filename: "SKILL.md",
      content: expect.stringContaining("Compare accounts."),
      mimeType: "text/markdown;charset=utf-8",
    }),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["network", "server"])(
  "retries a failed %s access check on the next mount",
  async (failure) => {
    const fetchMock = jest.mocked(fetch);
    if (failure === "network")
      fetchMock.mockRejectedValueOnce(new Error("Offline"));
    else fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    const first = render(<MySkills />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Flush the request's rejection and the fail-closed state update.
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Manage skills" })).toBeNull();
    first.unmount();
    render(<MySkills />);
    expect(
      await screen.findByRole("button", { name: "Manage skills" }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

it("supports a library opened outside the picker without a duplicate trigger", async () => {
  const onOpenChange = jest.fn();
  render(<MySkills open onOpenChange={onOpenChange} />);
  expect(await screen.findByRole("dialog", { name: "Skills" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage skills" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New skill" }));
  expect(screen.getByLabelText("Name")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
