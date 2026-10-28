import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";
import {
  ComposerStateProvider,
  useComposerActions,
  useComposerInput,
  useComposerGoalMode,
} from "../ComposerState";

describe("ComposerStateProvider", () => {
  it("keeps an edit version across responsive remounts and clears it when exiting goal mode", () => {
    function Draft({ id }: { id: string }) {
      const [enabled, setEnabled, generation] = useComposerGoalMode(id);
      return (
        <>
          <output>
            {enabled ? `Editing ${generation}` : "Normal message"}
          </output>
          <button onClick={() => setEnabled(true, 7)}>Edit goal</button>
          <button onClick={() => setEnabled(false)}>Exit goal</button>
        </>
      );
    }
    const ui = (key: string, id = "chat") => (
      <ComposerStateProvider>
        <Draft key={key} id={id} />
      </ComposerStateProvider>
    );
    const { rerender } = render(ui("mobile"));
    fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
    rerender(ui("desktop"));
    expect(screen.getByRole("status")).toHaveTextContent("Editing 7");
    rerender(ui("desktop", "other-chat"));
    expect(screen.getByRole("status")).toHaveTextContent("Normal message");
    rerender(ui("desktop"));
    fireEvent.click(screen.getByRole("button", { name: "Exit goal" }));
    rerender(ui("mobile"));
    expect(screen.getByRole("status")).toHaveTextContent("Normal message");
  });

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
