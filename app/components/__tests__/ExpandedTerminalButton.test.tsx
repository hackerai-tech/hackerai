import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { ExpandedTerminalButton } from "../ExpandedTerminalButton";
import type { SidebarTerminal } from "@/types/chat";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => <div>PTY viewport</div>,
}));

jest.mock("@/lib/utils/shiki", () => ({
  ...jest.requireActual("@/lib/utils/shiki"),
  isWebAssemblyAvailable: () => false,
}));

// jsdom has no layout observer; keep the real tooltip and dialog focus behavior.
const originalResizeObserver = global.ResizeObserver;
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterAll(() => {
  global.ResizeObserver = originalResizeObserver;
});

const terminal: SidebarTerminal = {
  command:
    "agent-browser eval \"document.title\" && printf 'UPPER!? café 日本語\\n'",
  output: "Example Domain\nUPPER!? café 日本語",
  isExecuting: false,
  toolCallId: "browser-command",
};

it("expands the complete command, updates streamed output, and restores focus on close", async () => {
  const onExpand = jest.fn();
  const view = render(
    <ExpandedTerminalButton terminal={terminal} onExpand={onExpand} />,
  );
  const trigger = screen.getByRole("button", {
    name: "Expand command and output",
  });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Command and output" });
  expect(
    await within(dialog).findByText(
      `$ ${terminal.command}\n${terminal.output}`,
      { normalizer: (text) => text },
    ),
  ).toBeVisible();
  expect(onExpand).toHaveBeenCalledTimes(1);
  view.rerender(
    <ExpandedTerminalButton
      terminal={{
        ...terminal,
        output: `${terminal.output}\nnew streamed line`,
      }}
      onExpand={onExpand}
    />,
  );
  expect(await within(dialog).findByText(/new streamed line/)).toBeVisible();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Close expanded command" }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("shows the exact original input for PTY snapshots and closes with Escape", () => {
  render(
    <ExpandedTerminalButton
      terminal={{ ...terminal, shellAction: "send", rawBytes: "" }}
      onExpand={jest.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Expand command and output" }),
  );
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(terminal.command)).toBeVisible();
  expect(
    within(dialog).queryByRole("button", { name: "Disable text wrapping" }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("preserves the pending approval state without claiming the command ran", () => {
  render(
    <ExpandedTerminalButton
      terminal={{
        ...terminal,
        output: "",
        executionPhase: "awaiting_approval",
      }}
      onExpand={jest.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Expand command and output" }),
  );
  expect(screen.getByText(`$ ${terminal.command}`)).toBeVisible();
  expect(screen.getByText("Awaiting approval…")).toBeVisible();
});
