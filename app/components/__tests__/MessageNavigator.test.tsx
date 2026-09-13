import { act, fireEvent, render, screen } from "@testing-library/react";
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
    const strips = document.querySelectorAll("[data-message-navigator-strip]");
    expect(strips[0]).toHaveClass("w-7");
    expect(strips[1]).toHaveClass("w-[22px]");
    expect(strips[2]).toHaveClass("w-3.5");

    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(screen.getByTestId("message-navigator-preview")).toHaveTextContent(
      "Second question",
    );
    expect(strips[0]).toHaveClass("w-[22px]");
    expect(strips[1]).toHaveClass("w-7");
    expect(strips[2]).toHaveClass("w-[22px]");

    fireEvent.keyDown(button, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("dismisses the preview when the pointer leaves the marker strip", () => {
    render(
      <MessageNavigator
        items={items}
        scrollElement={null}
        onSelect={jest.fn()}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Jump to message: User message",
    });
    button.getBoundingClientRect = () =>
      ({
        top: 100,
        right: 40,
        bottom: 122,
        left: 0,
        width: 40,
        height: 22,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;

    fireEvent.mouseMove(button, { clientY: 111 });
    const preview = screen.getByTestId("message-navigator-preview");
    expect(preview).toHaveTextContent("Second question");
    expect(preview).toHaveClass("pointer-events-none");

    fireEvent.mouseLeave(button);
    expect(
      screen.queryByTestId("message-navigator-preview"),
    ).not.toBeInTheDocument();
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

  it("refreshes visible destinations after resize without a scroll event", () => {
    const originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver",
    );
    let resizeCallback: ResizeObserverCallback | null = null;
    let observerInstance!: ResizeObserver;

    class ResizeObserverMock implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        observerInstance = this;
      }

      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverMock,
    });

    try {
      const scrollElement = document.createElement("div");
      const resizedRow = document.createElement("div");
      resizedRow.dataset.messageId = "user-2";
      scrollElement.append(resizedRow);
      let rowTop = 700;

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
      resizedRow.getBoundingClientRect = () =>
        ({
          top: rowTop,
          right: 700,
          bottom: rowTop + 80,
          left: 100,
          width: 600,
          height: 80,
          x: 100,
          y: rowTop,
          toJSON: () => ({}),
        }) as DOMRect;

      render(
        <MessageNavigator
          items={items}
          scrollElement={scrollElement}
          onSelect={jest.fn()}
        />,
      );

      const strips = document.querySelectorAll(
        "[data-message-navigator-strip]",
      );
      expect(strips[1]).toHaveAttribute("data-in-view", "false");

      rowTop = 100;
      act(() => {
        resizeCallback?.([], observerInstance);
      });

      expect(strips[1]).toHaveAttribute("data-in-view", "true");
    } finally {
      if (originalResizeObserverDescriptor) {
        Object.defineProperty(
          globalThis,
          "ResizeObserver",
          originalResizeObserverDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });
});
