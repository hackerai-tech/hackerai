import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../reasoning";

describe("Reasoning", () => {
  it("prevents long formatted reasoning text from creating page-width overflow", () => {
    render(
      <Reasoning open>
        <ReasoningTrigger />
        <ReasoningContent>
          <p>
            So using that, we can reverse-engineer:{" "}
            <code>53‡‡†305))6*;4826)4‡.)4‡);806*;48†8¶60))85</code>
          </p>
        </ReasoningContent>
      </Reasoning>,
    );

    const content = screen.getByText(/So using that/).closest("[data-state]");

    expect(content).toHaveClass("overflow-x-hidden");
    expect(content).toHaveClass("break-words");
    expect(content).toHaveClass("[overflow-wrap:anywhere]");
  });

  it("keeps visible reasoning open after streaming stops", async () => {
    const { rerender } = render(
      <Reasoning isStreaming>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    await waitFor(() => {
      expect(screen.getByText("Visible reasoning text")).toBeVisible();
    });

    rerender(
      <Reasoning isStreaming={false}>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    expect(screen.getByText("Visible reasoning text")).toBeVisible();
  });
});
