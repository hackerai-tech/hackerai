import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ComposerStateProvider,
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import {
  ComposerSkillSelections,
  ComposerSkillsButton,
  ComposerSkillsProvider,
  useComposerSkills,
} from "../ComposerSkills";

const mockLibrary = [
  {
    id: "one",
    name: "API review",
    description: "Authorization methodology",
    isDefault: true,
  },
  {
    id: "two",
    name: "Browser review",
    description: "Client behavior",
    isDefault: false,
  },
  {
    id: "three",
    name: "Evidence",
    description: "Record results",
    isDefault: false,
  },
  {
    id: "four",
    name: "Report",
    description: "Write findings",
    isDefault: false,
  },
];
let mockSelection: typeof mockLibrary = [];
let mockAccess = true;
const mockSelect = jest.fn();
const mockCapture = jest.fn();
const mockSaving = jest.fn();
const mockSubmit = jest.fn();
jest.mock("../../MySkills", () => ({
  useSkillsAccess: () => mockAccess,
  MySkills: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Skills">
        <button onClick={() => onOpenChange(false)}>Close library</button>
      </div>
    ) : null,
}));
jest.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) =>
    args === "skip" ? undefined : name === "list" ? mockLibrary : mockSelection,
  useMutation: () => mockSelect,
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    userSkills: { list: "list", selection: "selection", select: "select" },
  },
}));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));

function Input() {
  const skills = useComposerSkills();
  const input = useComposerInput();
  const { setInput } = useComposerActions();
  return (
    <div>
      <ComposerSkillSelections />
      <textarea
        aria-label="Message"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          skills?.inspect(e.currentTarget);
        }}
        onSelect={(e) => skills?.inspect(e.currentTarget)}
        onKeyDown={(e) => {
          if (
            !skills?.keyDown(e) &&
            e.key === "Enter" &&
            !e.nativeEvent.isComposing
          )
            mockSubmit();
        }}
      />
      <ComposerSkillsButton />
    </div>
  );
}
function Harness({
  chatId = "chat-1",
  disabled = false,
}: {
  chatId?: string;
  disabled?: boolean;
}) {
  return (
    <ComposerStateProvider>
      <ComposerSkillsProvider
        chatId={chatId}
        disabled={disabled}
        onSavingChange={mockSaving}
      >
        <Input />
      </ComposerSkillsProvider>
    </ComposerStateProvider>
  );
}
function typeAt(value: string, caret = value.length) {
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, {
    target: { value, selectionStart: caret, selectionEnd: caret },
  });
  return input;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAccess = true;
  mockSelection = [];
  mockSelect.mockImplementation(async ({ ids }: { ids: string[] }) => {
    mockSelection = mockLibrary.filter((skill) => ids.includes(skill.id));
  });
});

it("selects a matching skill with Enter, preserves surrounding draft text, and removes its chip", async () => {
  render(<Harness />);
  const input = typeAt("Please $author then review", 14);
  expect(screen.getByRole("option", { name: /API review/ })).toBeVisible();
  expect(screen.queryByRole("option", { name: /Browser review/ })).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input).toHaveValue("Please  then review"));
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockSelect).toHaveBeenCalledWith({ chatId: "chat-1", ids: ["one"] });
  fireEvent.click(
    screen.getByRole("button", { name: "Remove API review from this chat" }),
  );
  await waitFor(() =>
    expect(mockSelect).toHaveBeenLastCalledWith({ chatId: "chat-1", ids: [] }),
  );
  expect(
    screen.queryByRole("button", { name: "Remove API review from this chat" }),
  ).toBeNull();
  expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(
    "Authorization methodology",
  );
});

it("keeps the draft intact and shows a failed selection without recording success", async () => {
  mockSelect.mockRejectedValue(
    new Error("Wait for the current response to finish"),
  );
  render(<Harness />);
  const input = typeAt("$API");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Wait for the current response to finish",
  );
  expect(input).toHaveValue("$API");
  expect(
    mockCapture.mock.calls.some(
      ([event]) => event.event === "user_skills_selected",
    ),
  ).toBe(false);
  expect(mockSaving).toHaveBeenLastCalledWith(false);
});

it("supports button search and keyboard navigation while respecting an explicit empty selection", async () => {
  render(<Harness />);
  expect(screen.queryByRole("button", { name: /Remove API/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  const search = screen.getByRole("combobox", { name: "Search skills" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() =>
    expect(mockSelect).toHaveBeenCalledWith({ chatId: "chat-1", ids: ["two"] }),
  );
});

it("enforces the three-skill limit and disables changes during a response", async () => {
  mockSelection = mockLibrary.slice(0, 3);
  const { rerender } = render(<Harness />);
  const input = typeAt("$Report");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent("up to 3");
  expect(mockSelect).not.toHaveBeenCalled();
  rerender(<Harness disabled />);
  expect(screen.getByRole("button", { name: "Add skill" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Remove API review from this chat" }),
  ).toBeDisabled();
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("dismisses a trigger with Escape and leaves IME Enter alone", () => {
  render(<Harness />);
  const input = typeAt("$API");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(mockSelect).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.select(input);
  expect(screen.queryByRole("listbox")).toBeNull();
  typeAt("ordinary text");
  typeAt("$Browser");
  expect(screen.getByRole("option", { name: /Browser review/ })).toBeVisible();
});

it("does not apply an old chat's in-flight selection to a new chat draft", async () => {
  let resolve!: () => void;
  mockSelect.mockReturnValue(
    new Promise<void>((r) => {
      resolve = r;
    }),
  );
  const { rerender } = render(<Harness />);
  const input = typeAt("$API");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mockSaving).toHaveBeenLastCalledWith(true);
  rerender(<Harness chatId="chat-2" />);
  typeAt("$API in the second draft");
  await act(async () => resolve());
  expect(input).toHaveValue("$API in the second draft");
  expect(mockSaving).toHaveBeenLastCalledWith(false);
});

it("preserves the mounted composer draft when access becomes available", () => {
  mockAccess = false;
  const { rerender } = render(<Harness />);
  const input = typeAt("Unsubmitted draft");
  expect(screen.queryByRole("button", { name: "Add skill" })).toBeNull();
  mockAccess = true;
  rerender(<Harness />);
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
  expect(input).toHaveValue("Unsubmitted draft");
  expect(screen.getByRole("button", { name: "Add skill" })).toBeVisible();
});

it("closes the picker when opening the library and keeps the library mounted", async () => {
  render(<Harness />);
  const input = typeAt("Review $API");
  expect(screen.getByRole("listbox", { name: "Skills" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Manage skills" }));
  expect(screen.getByRole("dialog", { name: "Skills" })).toBeVisible();
  expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
  expect(input).toHaveValue("Review $API");
  fireEvent.click(screen.getByRole("button", { name: "Close library" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(input).toHaveFocus());
  expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  expect(screen.getByRole("listbox", { name: "Skills" })).toBeVisible();
});
