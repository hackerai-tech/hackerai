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
  it("shows a single queued message directly with compact steer actions", () => {
    const onSendNow = jest.fn();
    const onDelete = jest.fn();

    render(
      <QueuedMessagesPanel
        messages={[messages[0]]}
        onSendNow={onSendNow}
        onDelete={onDelete}
        isStreaming
      />,
    );

    expect(screen.getByText("do ping now")).toBeInTheDocument();
    expect(screen.queryByText("1 Queued")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse queued messages" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove queued message" }),
    );

    expect(onSendNow).toHaveBeenCalledWith("message-1");
    expect(onDelete).toHaveBeenCalledWith("message-1");
    expect(
      screen.getByRole("button", { name: "Queue settings" }),
    ).toBeInTheDocument();
  });

  it("keeps the collapsible count view for multiple queued messages", () => {
    render(
      <QueuedMessagesPanel
        messages={messages}
        onSendNow={jest.fn()}
        onDelete={jest.fn()}
        isStreaming
      />,
    );

    expect(screen.getByText("2 Queued")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Steer" })).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse queued messages" }),
    );

    expect(screen.queryByText("do ping now")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand queued messages" }),
    ).toBeInTheDocument();
  });
});
