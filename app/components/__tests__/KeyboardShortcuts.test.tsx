import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { KeyboardShortcuts } from "../KeyboardShortcuts";
import { openKeyboardShortcuts } from "@/lib/keyboard-shortcuts";

let mockIsMobile = false;
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mockIsMobile }));
jest.mock("../MessageSearchDialog", () => ({
  MessageSearchDialog: ({
    isOpen,
    onClose,
  }: {
    isOpen: boolean;
    onClose: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label="Search">
        <button onClick={onClose}>Close search</button>
      </div>
    ) : null,
}));

const mockStartNewChat = jest.fn();
jest.mock("@/app/hooks/useStartNewChat", () => ({
  useStartNewChat: () => mockStartNewChat,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile = false;
});

it("opens from Help, dismisses with Escape, and returns focus", async () => {
  render(
    <>
      <button onClick={openKeyboardShortcuts}>Keyboard shortcuts</button>
      <KeyboardShortcuts />
    </>,
  );
  const trigger = screen.getByRole("button");
  trigger.focus();
  fireEvent.click(trigger);
  expect(
    screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(0);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
});

it("opens and closes with Ctrl+/, including from a composer field", async () => {
  render(
    <>
      <textarea aria-label="Composer" />
      <KeyboardShortcuts />
    </>,
  );
  const composer = screen.getByRole("textbox");
  composer.focus();
  fireEvent.keyDown(composer, { key: "/", ctrlKey: true });
  expect(
    screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeInTheDocument();
  fireEvent.keyDown(document.activeElement!, { key: "/", ctrlKey: true });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(composer).toHaveFocus();
});

it("starts one new task and protects dialogs, terminal and editor input", () => {
  const { container } = render(
    <>
      <textarea aria-label="Composer" />
      <div className="xterm">
        <textarea aria-label="Terminal" />
      </div>
      <div className="monaco-editor">
        <textarea aria-label="Editor" />
      </div>
      <KeyboardShortcuts />
    </>,
  );
  fireEvent.keyDown(screen.getByLabelText("Composer"), {
    key: "O",
    ctrlKey: true,
    shiftKey: true,
  });
  expect(mockStartNewChat).toHaveBeenCalledTimes(1);
  mockStartNewChat.mockClear();
  for (const label of ["Terminal", "Editor"]) {
    fireEvent.keyDown(screen.getByLabelText(label), {
      key: "O",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(screen.getByLabelText(label), {
      key: "/",
      ctrlKey: true,
    });
  }
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  container.append(dialog);
  fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: "/", ctrlKey: true });
  expect(mockStartNewChat).not.toHaveBeenCalled();
  expect(
    screen.queryByText("Move faster in HackerAI with your keyboard."),
  ).not.toBeInTheDocument();
  dialog.remove();
  act(() => openKeyboardShortcuts());
  fireEvent.keyDown(document.activeElement!, {
    key: "O",
    ctrlKey: true,
    shiftKey: true,
  });
  expect(mockStartNewChat).not.toHaveBeenCalled();
});

it("keeps navigation shortcuts available when the narrow-screen sidebar is unmounted", () => {
  mockIsMobile = true;
  const toggle = jest.fn();
  const { rerender } = render(
    <KeyboardShortcuts onToggleMobileSidebar={toggle} />,
  );
  fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
  expect(toggle).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
  mockIsMobile = false;
  rerender(<KeyboardShortcuts onToggleMobileSidebar={toggle} />);
  expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close search" }));
  mockIsMobile = true;
  rerender(<KeyboardShortcuts onToggleMobileSidebar={toggle} />);
  expect(
    screen.queryByRole("dialog", { name: "Search" }),
  ).not.toBeInTheDocument();
});
