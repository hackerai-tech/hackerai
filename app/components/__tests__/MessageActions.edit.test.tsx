import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@/components/ui/with-tooltip", () => ({
  WithTooltip: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

const { MessageActions } =
  require("../MessageActions") as typeof import("../MessageActions");

const renderUserActions = (canEdit: boolean, onEdit = jest.fn()) => {
  render(
    <MessageActions
      messageText="Question"
      isUser
      isLastAssistantMessage={false}
      canRegenerate={false}
      onRegenerate={jest.fn()}
      onEdit={onEdit}
      canEdit={canEdit}
      isHovered
      isEditing={false}
      status="ready"
    />,
  );

  return onEdit;
};

const renderAssistantActions = (
  canRegenerate: boolean,
  onRegenerate = jest.fn(),
) => {
  render(
    <MessageActions
      messageText="Answer"
      isUser={false}
      isLastAssistantMessage
      canRegenerate={canRegenerate}
      onRegenerate={onRegenerate}
      onEdit={jest.fn()}
      canEdit={false}
      isHovered
      isEditing={false}
      status="ready"
    />,
  );

  return onRegenerate;
};

describe("MessageActions editing", () => {
  it("does not offer editing for an older user message", () => {
    renderUserActions(false);

    expect(
      screen.queryByRole("button", { name: "Edit message" }),
    ).not.toBeInTheDocument();
  });

  it("offers editing for the latest user message", () => {
    const onEdit = renderUserActions(true);

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("clears the copied-state timeout when the actions unmount", async () => {
    jest.useFakeTimers();
    const writeText = jest.fn<any>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { unmount } = render(
      <MessageActions
        messageText="Answer"
        isUser={false}
        isLastAssistantMessage={false}
        canRegenerate={false}
        onRegenerate={jest.fn()}
        onEdit={jest.fn()}
        canEdit={false}
        isHovered
        isEditing={false}
        status="ready"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await act(async () => Promise.resolve());
    expect(writeText).toHaveBeenCalledWith("Answer");
    const pendingTimersAfterCopy = jest.getTimerCount();
    expect(pendingTimersAfterCopy).toBeGreaterThan(0);
    unmount();
    expect(jest.getTimerCount()).toBe(pendingTimersAfterCopy - 1);
    act(() => jest.runOnlyPendingTimers());

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
    jest.useRealTimers();
  });
});

describe("MessageActions regeneration", () => {
  it("does not show regeneration when it is unavailable", () => {
    renderAssistantActions(false);

    expect(
      screen.queryByRole("button", { name: "Regenerate response" }),
    ).not.toBeInTheDocument();
  });

  it("shows regeneration when it is available", async () => {
    const onRegenerate = renderAssistantActions(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Regenerate response" }),
    );

    await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1));
  });
});

describe("MessageActions feedback", () => {
  it("renders saved positive feedback as a filled thumbs-up icon", () => {
    render(
      <MessageActions
        messageText="Answer"
        isUser={false}
        isLastAssistantMessage
        canRegenerate={false}
        onRegenerate={jest.fn()}
        onEdit={jest.fn()}
        canEdit={false}
        isHovered
        isEditing={false}
        status="ready"
        onFeedback={jest.fn()}
        existingFeedback="positive"
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Good response" })
        .querySelector("svg"),
    ).toHaveAttribute("fill", "currentColor");
  });
});

describe("MessageActions branching", () => {
  it("shows the branch icon horizontally", () => {
    render(
      <MessageActions
        messageText="Answer"
        isUser={false}
        isLastAssistantMessage
        canRegenerate={false}
        onRegenerate={jest.fn()}
        onEdit={jest.fn()}
        canEdit={false}
        onBranch={jest.fn()}
        isHovered
        isEditing={false}
        status="ready"
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Branch in new task" })
        .querySelector("svg"),
    ).toHaveClass("rotate-90");
  });
});

it("keeps public favicons while withholding private sources in actions and citations", () => {
  const sources = [
    {
      title: "Public source",
      url: "https://example.com/private?q=secret#fragment",
    },
    { title: "Internal source", url: "https://user:pass@internal.test/report" },
    { title: "Malformed source", url: "not-a-url?secret=value" },
  ];
  render(
    <MessageActions
      messageText="Answer"
      isUser={false}
      isLastAssistantMessage
      canRegenerate={false}
      onRegenerate={jest.fn()}
      onEdit={jest.fn()}
      canEdit={false}
      isHovered
      isEditing={false}
      status="ready"
      sources={sources}
    />,
  );
  const button = screen.getByRole("button", { name: "View sources" });
  expect(button.querySelectorAll("img")).toHaveLength(1);
  expect(button.querySelector("img")).toHaveAttribute(
    "src",
    "https://www.google.com/s2/favicons?domain=example.com&sz=32",
  );
  fireEvent.click(button);
  const dialog = screen.getByRole("dialog", { name: "Citations" });
  expect(dialog.querySelectorAll("img")).toHaveLength(1);
  expect(dialog.querySelector("img")).toHaveAttribute(
    "src",
    "https://www.google.com/s2/favicons?domain=example.com&sz=32",
  );
  for (const source of sources) {
    expect(
      screen.getByRole("link", { name: new RegExp(source.title) }),
    ).toHaveAttribute("href", source.url);
  }
});
