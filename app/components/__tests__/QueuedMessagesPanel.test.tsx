import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueuedMessagesPanel } from "../QueuedMessagesPanel";
import type { QueuedMessage } from "@/types/chat";

const messages: QueuedMessage[] = [
  {
    id: "message-1",
    text: "do ping now",
    timestamp: 1,
  },
  {
    id: "message-2",
    text: "then check the headers",
    timestamp: 2,
  },
];

describe("QueuedMessagesPanel", () => {
  it("shows a single queued message directly with compact steer actions", async () => {
    const onSendNow = jest.fn();
    const onDelete = jest.fn();
    const onQueueBehaviorChange = jest.fn();

    const { rerender } = render(
      <QueuedMessagesPanel
        messages={[messages[0]]}
        onSendNow={onSendNow}
        onEdit={jest.fn()}
        onEditingMessageChange={jest.fn()}
        onDelete={onDelete}
        isStreaming
        onQueueBehaviorChange={onQueueBehaviorChange}
      />,
    );

    expect(screen.getByText("do ping now")).toBeInTheDocument();
    expect(screen.queryByText("1 Queued")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse queued messages" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove queued message: do ping now",
      }),
    );

    expect(onSendNow).toHaveBeenCalledWith("message-1");
    expect(onDelete).toHaveBeenCalledWith("message-1");
    expect(
      screen.getByRole("button", {
        name: "More options for queued message: do ping now",
      }),
    ).toBeInTheDocument();

    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "More options for queued message: do ping now",
      }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Turn off queueing",
      }),
    );

    expect(onQueueBehaviorChange).toHaveBeenCalledWith("stop-and-send");

    rerender(
      <QueuedMessagesPanel
        messages={[messages[0]]}
        onSendNow={onSendNow}
        onEdit={jest.fn()}
        onEditingMessageChange={jest.fn()}
        onDelete={onDelete}
        isStreaming
        queueBehavior="stop-and-send"
        onQueueBehaviorChange={onQueueBehaviorChange}
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "More options for queued message: do ping now",
      }),
      { key: "Enter" },
    );
    expect(
      await screen.findByRole("menuitem", { name: "Turn on queueing" }),
    ).toBeInTheDocument();
  });

  it("shows multiple queued messages as a flat list", () => {
    const onQueueBehaviorChange = jest.fn();

    render(
      <QueuedMessagesPanel
        messages={messages}
        onSendNow={jest.fn()}
        onEdit={jest.fn()}
        onEditingMessageChange={jest.fn()}
        onDelete={jest.fn()}
        isStreaming
        onQueueBehaviorChange={onQueueBehaviorChange}
      />,
    );

    expect(screen.queryByText("2 Queued")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Steer" })).toHaveLength(2);
    expect(screen.getByText("do ping now")).toBeInTheDocument();
    expect(screen.getByText("then check the headers")).toBeInTheDocument();
    expect(
      screen.queryByText("When to send follow-ups"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Queue settings" }),
    ).not.toBeInTheDocument();
  });

  it("allows a stopped queued message to be sent immediately", () => {
    const onSendNow = jest.fn();

    render(
      <QueuedMessagesPanel
        messages={[messages[0]]}
        onSendNow={onSendNow}
        onEdit={jest.fn()}
        onEditingMessageChange={jest.fn()}
        onDelete={jest.fn()}
        isStreaming={false}
      />,
    );

    const steerButton = screen.getByRole("button", { name: "Steer" });
    expect(steerButton).toBeEnabled();
    expect(steerButton).toHaveAttribute(
      "title",
      "Send this queued message now",
    );

    fireEvent.click(steerButton);
    expect(onSendNow).toHaveBeenCalledWith("message-1");
  });

  it("edits a specific queued message from its menu", async () => {
    const onEdit = jest.fn();
    const onEditingMessageChange = jest.fn();

    render(
      <QueuedMessagesPanel
        messages={messages}
        onSendNow={jest.fn()}
        onEdit={onEdit}
        onEditingMessageChange={onEditingMessageChange}
        onDelete={jest.fn()}
        isStreaming
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "More options for queued message: do ping now",
      }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Edit message" }),
    );

    expect(onEditingMessageChange).toHaveBeenCalledWith("message-1");

    const editor = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(editor, { target: { value: "do ping carefully" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onEdit).toHaveBeenCalledWith("message-1", "do ping carefully");
    expect(onEditingMessageChange).toHaveBeenLastCalledWith(null);
    expect(
      screen.queryByRole("button", { name: /Reorder queued message/ }),
    ).not.toBeInTheDocument();
  });
});
