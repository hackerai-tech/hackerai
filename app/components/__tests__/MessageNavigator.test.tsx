import { fireEvent, render, screen } from "@testing-library/react";
import { MessageNavigator } from "../MessageNavigator";
import type { MessageNavigatorItem } from "../message-navigator";

const items: MessageNavigatorItem[] = [
  {
    id: "user-1",
    rowIndex: 0,
    userText: "First question",
    assistantText: "First answer",
  },
  {
    id: "user-2",
    rowIndex: 2,
    userText: "Second question",
    assistantText: "Second answer",
  },
  {
    id: "user-3",
    rowIndex: 4,
    userText: "Third question",
    assistantText: null,
  },
];

describe("MessageNavigator", () => {
  it("stays hidden until a chat has multiple user turns", () => {
    const { rerender } = render(
      <MessageNavigator
        items={items.slice(0, 1)}
        scrollElement={null}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.queryByTestId("message-navigator")).not.toBeInTheDocument();

    rerender(
      <MessageNavigator
        items={items.slice(0, 2)}
        scrollElement={null}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.getByTestId("message-navigator")).toBeInTheDocument();
  });

  it("previews and selects a destination with the keyboard", () => {
    const onSelect = jest.fn();
    render(
      <MessageNavigator
        items={items}
        scrollElement={null}
        onSelect={onSelect}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Jump to message: User message",
    });
    fireEvent.focus(button);

    expect(screen.getByTestId("message-navigator-preview")).toHaveTextContent(
      "First question",
    );

    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(screen.getByTestId("message-navigator-preview")).toHaveTextContent(
      "Second question",
    );

    fireEvent.keyDown(button, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("marks destinations whose user rows are in the viewport", () => {
    const scrollElement = document.createElement("div");
    const visibleRow = document.createElement("div");
    visibleRow.dataset.messageId = "user-2";
    scrollElement.append(visibleRow);

    scrollElement.getBoundingClientRect = () =>
      ({
        top: 0,
        right: 900,
        bottom: 600,
        left: 0,
        width: 900,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    visibleRow.getBoundingClientRect = () =>
      ({
        top: 100,
        right: 700,
        bottom: 180,
        left: 100,
        width: 600,
        height: 80,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;

    render(
      <MessageNavigator
        items={items}
        scrollElement={scrollElement}
        onSelect={jest.fn()}
      />,
    );
    fireEvent.scroll(scrollElement);

    const strips = document.querySelectorAll("[data-message-navigator-strip]");
    expect(strips[0]).toHaveAttribute("data-in-view", "false");
    expect(strips[1]).toHaveAttribute("data-in-view", "true");
    expect(strips[2]).toHaveAttribute("data-in-view", "false");
  });
});
