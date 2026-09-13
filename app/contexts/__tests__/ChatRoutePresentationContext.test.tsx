import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ChatRoutePresentationProvider,
  useChatRoutePresentation,
} from "../ChatRoutePresentationContext";

const PresentationProbe = ({ chatId }: { chatId: string }) => {
  const { hasResolvedInitialPresentation, markInitialPresentationResolved } =
    useChatRoutePresentation();

  return (
    <div>
      <span data-testid="presentation-state">
        {hasResolvedInitialPresentation ? "resolved" : "loading"}
      </span>
      <span data-testid="presentation-chat-id">{chatId}</span>
      <button type="button" onClick={markInitialPresentationResolved}>
        Resolve presentation
      </button>
    </div>
  );
};

describe("ChatRoutePresentationProvider", () => {
  it("keeps the initial presentation resolved across keyed chat remounts", () => {
    const renderProbe = (chatId: string) => (
      <ChatRoutePresentationProvider>
        <PresentationProbe key={chatId} chatId={chatId} />
      </ChatRoutePresentationProvider>
    );
    const { rerender } = render(renderProbe("chat-a"));

    expect(screen.getByTestId("presentation-state")).toHaveTextContent(
      "loading",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Resolve presentation" }),
    );
    expect(screen.getByTestId("presentation-state")).toHaveTextContent(
      "resolved",
    );

    rerender(renderProbe("chat-b"));

    expect(screen.getByTestId("presentation-chat-id")).toHaveTextContent(
      "chat-b",
    );
    expect(screen.getByTestId("presentation-state")).toHaveTextContent(
      "resolved",
    );
  });
});
