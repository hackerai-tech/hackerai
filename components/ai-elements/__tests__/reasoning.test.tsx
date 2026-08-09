import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../reasoning";

describe("Reasoning", () => {
  it("keeps expanded-content spacing off the collapsible row wrapper", () => {
    render(
      <Reasoning open>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    const trigger = screen.getByRole("button", { name: "Reasoning" });
    const wrapper = trigger.closest('[data-slot="collapsible"]');
    const content = screen
      .getByText("Visible reasoning text")
      .closest('[data-slot="collapsible-content"]');

    expect(wrapper).not.toHaveClass("space-y-2");
    expect(content).toHaveClass("mt-2");
  });

  it("uses the full disclosure row on mobile and desktop", () => {
    render(
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    const trigger = screen.getByRole("button", { name: "Reasoning" });
    const label = screen.getByText("Reasoning");
    const chevron = screen.getByTestId("reasoning-chevron");

    expect(trigger).toHaveClass("w-full");
    expect(trigger).not.toHaveClass("desktop:w-fit");
    expect(label).not.toHaveClass("flex-1");
    expect(chevron).toHaveClass("opacity-100");
    expect(chevron).toHaveClass("desktop:opacity-0");
    expect(chevron).toHaveClass("desktop:group-hover:opacity-100");
    expect(chevron).toHaveClass("desktop:group-focus-visible:opacity-100");
    expect(chevron).toHaveClass("touch-device:!opacity-100");
  });

  it("uses only shimmer text while reasoning is active", () => {
    render(
      <Reasoning isStreaming>
        <ReasoningTrigger />
      </Reasoning>,
    );

    expect(screen.getByText("Thinking...")).toHaveClass("animate-text-shimmer");
    expect(
      screen.queryByTestId("reasoning-streaming-indicator"),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-ping")).not.toBeInTheDocument();
  });

  it("can stay open without shimmering after reasoning activity stops", async () => {
    render(
      <Reasoning isStreaming isActive={false}>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    await waitFor(() => {
      expect(screen.getByText("Visible reasoning text")).toBeVisible();
    });
    expect(screen.getByText("Reasoning")).not.toHaveClass(
      "animate-text-shimmer",
    );
    expect(
      screen.queryByTestId("reasoning-streaming-indicator"),
    ).not.toBeInTheDocument();
  });

  it("points right when closed and down when expanded", () => {
    render(
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    const trigger = screen.getByRole("button", { name: "Reasoning" });
    expect(screen.getByTestId("reasoning-chevron")).toHaveClass(
      "lucide-chevron-right",
    );

    fireEvent.click(trigger);

    expect(screen.getByTestId("reasoning-chevron")).toHaveClass(
      "lucide-chevron-down",
    );
  });

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

  it("keeps the reasoning row visible but collapses content after streaming stops", async () => {
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

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText("Visible reasoning text"),
      ).not.toBeInTheDocument();
    });
  });

  it("can defer content collapse to a parent work panel", async () => {
    const { rerender } = render(
      <Reasoning isStreaming collapseWhenInactive={false}>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    await waitFor(() => {
      expect(screen.getByText("Visible reasoning text")).toBeVisible();
    });

    rerender(
      <Reasoning isStreaming={false} collapseWhenInactive={false}>
        <ReasoningTrigger />
        <ReasoningContent>Visible reasoning text</ReasoningContent>
      </Reasoning>,
    );

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Visible reasoning text")).toBeVisible();
  });
});
