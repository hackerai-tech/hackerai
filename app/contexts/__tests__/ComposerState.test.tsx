import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";
import {
  ComposerStateProvider,
  useComposerActions,
  useComposerInput,
} from "../ComposerState";

describe("ComposerStateProvider", () => {
  it("updates input subscribers without rerendering action-only consumers", () => {
    const actionConsumerRendered = jest.fn();
    const inputConsumerRendered = jest.fn();

    function ActionConsumer() {
      actionConsumerRendered();
      const { getInput, setInput } = useComposerActions();

      return (
        <>
          <button type="button" onClick={() => setInput("updated prompt")}>
            Update prompt
          </button>
          <button type="button" onClick={() => getInput()}>
            Read prompt
          </button>
        </>
      );
    }

    function InputConsumer() {
      inputConsumerRendered();
      const input = useComposerInput();
      return <div data-testid="composer-input">{input}</div>;
    }

    render(
      <ComposerStateProvider>
        <ActionConsumer />
        <InputConsumer />
      </ComposerStateProvider>,
    );

    expect(actionConsumerRendered).toHaveBeenCalledTimes(1);
    expect(inputConsumerRendered).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Update prompt" }));

    expect(screen.getByTestId("composer-input")).toHaveTextContent(
      "updated prompt",
    );
    expect(actionConsumerRendered).toHaveBeenCalledTimes(1);
    expect(inputConsumerRendered).toHaveBeenCalledTimes(2);
  });

  it("exposes the latest input to event handlers without a value subscription", () => {
    let latestInput = "";

    function ActionConsumer() {
      const { getInput, setInput } = useComposerActions();
      return (
        <>
          <button type="button" onClick={() => setInput("send this")}>
            Update prompt
          </button>
          <button type="button" onClick={() => (latestInput = getInput())}>
            Read prompt
          </button>
        </>
      );
    }

    render(
      <ComposerStateProvider>
        <ActionConsumer />
      </ComposerStateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Read prompt" }));

    expect(latestInput).toBe("send this");
  });
});
