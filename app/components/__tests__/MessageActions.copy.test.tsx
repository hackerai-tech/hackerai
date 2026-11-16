import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

jest.mock("@/components/ui/with-tooltip", () => ({
  WithTooltip: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

const { MessageActions } =
  require("../MessageActions") as typeof import("../MessageActions");

const MESSAGE_TEXT = "Exact answer\n  with `code` and trailing space ";

const mockClipboard = (writeText: (text: string) => Promise<void>) => {
  const mock = jest.fn(writeText);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock },
  });
  return mock;
};

const renderActions = () =>
  render(
    <>
      <MessageActions
        messageText={MESSAGE_TEXT}
        isUser={false}
        isLastAssistantMessage
        canRegenerate={false}
        onRegenerate={jest.fn()}
        onEdit={jest.fn()}
        canEdit={false}
        isHovered
        isEditing={false}
        status="ready"
      />
      <Toaster />
    </>,
  );

const visibleToasts = () =>
  Array.from(document.querySelectorAll("[data-sonner-toast]"));

describe("MessageActions copy failure feedback", () => {
  afterEach(() => {
    act(() => {
      toast.dismiss();
    });
    jest.restoreAllMocks();
  });

  it("shows one retryable notice without details, then copies on retry", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const writeText = mockClipboard(async () => {
      throw new Error("NotAllowedError: private browser detail");
    });
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(await screen.findByText("Could not copy message")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Copied!" }),
    ).not.toBeInTheDocument();

    // A second failure updates the same notice instead of stacking another.
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(visibleToasts()).toHaveLength(1));
    const notice = visibleToasts()[0];
    expect(notice).not.toHaveTextContent(/private browser detail/);
    expect(notice.textContent).not.toContain("Exact answer");

    writeText.mockImplementation(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("button", { name: "Copied!" }),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(writeText).toHaveBeenLastCalledWith(MESSAGE_TEXT);
    await waitFor(() =>
      expect(
        screen.queryByText("Could not copy message"),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps each message's failure notice independent", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const writeText = mockClipboard(async () => {
      throw new Error("Document is not focused");
    });
    const actionProps = {
      isUser: false,
      isLastAssistantMessage: false,
      canRegenerate: false,
      onRegenerate: () => {},
      onEdit: () => {},
      canEdit: false,
      isHovered: true,
      isEditing: false,
      status: "ready" as const,
    };
    render(
      <>
        <MessageActions messageText="First answer" {...actionProps} />
        <MessageActions messageText="Second answer" {...actionProps} />
        <Toaster />
      </>,
    );
    const [firstCopy, secondCopy] = screen.getAllByRole("button", {
      name: "Copy message",
    });

    fireEvent.click(firstCopy);
    fireEvent.click(secondCopy);
    await waitFor(() => expect(visibleToasts()).toHaveLength(2));

    // Copying the first message succeeds; the second message's retry remains.
    writeText.mockImplementation(async () => {});
    fireEvent.click(firstCopy);
    await waitFor(() => expect(visibleToasts()).toHaveLength(1));
    expect(screen.getByText("Could not copy message")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("Second answer"),
    );
  });

  it("clears an earlier Copied state when a later copy fails", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const writeText = mockClipboard(async () => {});
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(
      await screen.findByRole("button", { name: "Copied!" }),
    ).toBeInTheDocument();

    writeText.mockImplementation(async () => {
      throw new Error("Document is not focused");
    });
    fireEvent.click(screen.getByRole("button", { name: "Copied!" }));

    expect(await screen.findByText("Could not copy message")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy message" }),
    ).toBeInTheDocument();
  });

  it("does not start the copied-state timer when a copy settles after unmount", async () => {
    jest.useFakeTimers();
    try {
      let resolveWrite!: () => void;
      mockClipboard(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      const { unmount } = render(
        <MessageActions
          messageText={MESSAGE_TEXT}
          isUser={false}
          isLastAssistantMessage
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
      unmount();
      const timersAfterUnmount = jest.getTimerCount();
      // Nothing is mounted, so settle outside act to count only component timers.
      resolveWrite();
      await Promise.resolve();
      await Promise.resolve();

      expect(jest.getTimerCount()).toBe(timersAfterUnmount);
    } finally {
      jest.useRealTimers();
    }
  });
});
