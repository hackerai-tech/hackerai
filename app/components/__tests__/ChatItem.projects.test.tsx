import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/",
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    closeSidebar: jest.fn(),
    setChatSidebarOpen: jest.fn(),
    initializeNewChat: jest.fn(),
    initializeChat: jest.fn(),
    optimisticChatId: null,
    setOptimisticChatId: jest.fn(),
  }),
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));
jest.mock("convex/react", () => ({
  useMutation: () => jest.fn(),
}));
jest.mock("@/app/hooks/useChats", () => ({
  usePinChat: () => jest.fn(),
  useUnpinChat: () => jest.fn(),
}));
jest.mock("../ShareDialog", () => ({
  ShareDialog: () => null,
}));
jest.mock("../MoveChatToProjectDialog", () => ({
  MoveChatToProjectDialog: () => (
    <div data-testid="move-chat-to-project-dialog" />
  ),
}));

const ChatItem = require("../ChatItem")
  .default as typeof import("../ChatItem").default;

describe("ChatItem project actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reveals an accessible move action when the row receives keyboard focus", async () => {
    const user = userEvent.setup();
    render(<ChatItem id="chat-1" title="Target notes" />);

    fireEvent.focus(screen.getByRole("button", { name: /Open task:/ }));
    await user.click(
      screen.getByRole("button", { name: "Open conversation options" }),
    );

    await user.click(
      await screen.findByRole("menuitem", { name: "Move to project…" }),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("move-chat-to-project-dialog"),
      ).toBeInTheDocument();
    });
  });

  it("uses compact side padding for standard and project chat rows", () => {
    render(
      <>
        <ChatItem id="chat-1" title="General notes" />
        <ChatItem id="chat-2" title="Target notes" indentContent />
      </>,
    );

    expect(screen.getByTestId("chat-item-chat-1")).toHaveClass(
      "py-2",
      "ps-2",
      "pe-0.5",
    );
    expect(screen.getByTestId("chat-item-chat-2")).toHaveClass(
      "py-2",
      "ps-6",
      "pe-0.5",
    );
    expect(screen.getByTestId("chat-item-chat-1")).not.toHaveClass("p-2");
    expect(screen.getByTestId("chat-item-chat-2")).not.toHaveClass("p-2");
  });
});
