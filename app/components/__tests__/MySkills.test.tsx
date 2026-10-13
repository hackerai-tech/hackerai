import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MySkills } from "../MySkills";

let mockUserId = "";
let mockAuthenticated = true;
let mockSelection: unknown[] = [];
const mockSave = jest.fn();
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
  useConvex: () => ({ query: jest.fn() }),
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
  expect(screen.queryByRole("button", { name: "My Skills" })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  mockAuthenticated = true;
  rerender(<MySkills chatId="chat-1" />);
  expect(
    await screen.findByRole("button", { name: "My Skills" }),
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

it("keeps an explicit empty chat selection separate from defaults and exposes selection failures", async () => {
  mockSelect.mockRejectedValue(
    new Error("Wait for the current response to finish"),
  );
  render(<MySkills chatId="chat-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "My Skills" }));
  expect(
    screen.getByRole("checkbox", { name: "Use in this chat" }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Default for new chats" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Use in this chat" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Wait for the current response to finish",
  );
  expect(mockSelect).toHaveBeenCalledWith({
    chatId: "chat-1",
    ids: ["skill-1"],
  });
  expect(
    screen.getByRole("checkbox", { name: "Use in this chat" }),
  ).not.toBeChecked();
  expect(
    mockCapture.mock.calls.some(
      ([event]) => event.event === "user_skills_selected",
    ),
  ).toBe(false);
});

it("imports Markdown into the same review flow without saving automatically", async () => {
  render(<MySkills chatId="chat-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "My Skills" }));
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
