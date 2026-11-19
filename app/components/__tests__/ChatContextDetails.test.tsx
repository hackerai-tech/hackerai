import "@testing-library/jest-dom";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  CONTEXT_DETAILS_STORAGE_KEY,
  useContextDetailsPreference,
} from "@/app/hooks/useContextDetailsPreference";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    toggleChatSidebar: jest.fn(),
    subscription: "pro",
    isCheckingProPlan: false,
    initializeNewChat: jest.fn(),
    closeSidebar: jest.fn(),
    setChatSidebarOpen: jest.fn(),
  }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("@/app/components/ShareDialog", () => ({ ShareDialog: () => null }));
jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));
jest.mock("@/app/hooks/useTauri", () => ({ navigateToAuth: jest.fn() }));
jest.mock("@/lib/analytics/client", () => ({
  captureUpgradeCtaImpression: jest.fn(),
}));

// Loaded after the mocks above so the header uses them.
const ChatHeader = (
  require("@/app/components/ChatHeader") as typeof import("@/app/components/ChatHeader")
).default;
const { ChatContextDetails } =
  require("@/app/components/ChatContextDetails") as typeof import("@/app/components/ChatContextDetails");

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
});

const renderHeader = (
  chatData: Parameters<typeof ChatHeader>[0]["chatData"],
  { hasMessages = true }: { hasMessages?: boolean } = {},
) =>
  render(
    <ChatHeader
      hasMessages={hasMessages}
      hasActiveChat={hasMessages}
      isExistingChat={hasMessages}
      chatTitle="Recon staging.example.test"
      id="chat-1"
      chatData={chatData}
    />,
  );

const trigger = () => screen.queryByRole("button", { name: "Context details" });

describe("Context details in the chat header", () => {
  beforeEach(() => window.localStorage.clear());

  it("stays hidden until enabled, then appears only for Agent chats", () => {
    const agentChat = { default_model_slug: "agent" as const };
    const expectHidden = (view: ReturnType<typeof renderHeader>) => {
      // Assert while mounted; after unmount every query is trivially empty.
      expect(screen.getByText("Share")).toBeInTheDocument();
      expect(trigger()).not.toBeInTheDocument();
      view.unmount();
    };
    expectHidden(renderHeader(agentChat));

    window.localStorage.setItem(CONTEXT_DETAILS_STORAGE_KEY, "true");
    expectHidden(renderHeader({ default_model_slug: "ask" }));
    const emptyChat = renderHeader(agentChat, { hasMessages: false });
    expect(trigger()).not.toBeInTheDocument();
    emptyChat.unmount();

    for (const chat of [
      agentChat,
      { active_trigger_run_id: "run-1" },
      { agent_compaction_count: 0 },
    ]) {
      const view = renderHeader(chat);
      expect(trigger()).toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("useContextDetailsPreference", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps this tab's choice when saving fails but reading still works", () => {
    const { result } = renderHook(() => useContextDetailsPreference());
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      act(() => result.current[1](true));
      expect(window.localStorage.getItem(CONTEXT_DETAILS_STORAGE_KEY)).toBe(
        null,
      );
      expect(result.current[0]).toBe(true);
    } finally {
      setItem.mockRestore();
    }

    // A later successful write clears the fallback and is stored normally.
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(window.localStorage.getItem(CONTEXT_DETAILS_STORAGE_KEY)).toBe(
      "true",
    );
    act(() => result.current[1](false));
  });
});

describe("ChatContextDetails", () => {
  it("opens from the keyboard and shows a recorded zero with its scope", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ChatContextDetails completedCompactions={0} />,
    );

    await user.tab();
    expect(trigger()).toHaveFocus();
    await user.keyboard("{Enter}");

    const details = screen.getByRole("dialog", { name: "Agent context" });
    expect(details).toHaveTextContent("This chat");
    expect(details).toHaveTextContent("Completed compactions0");
    expect(details).toHaveTextContent(
      "Includes compactions recorded since tracking began.",
    );
    expect(details).not.toHaveTextContent("Unavailable");

    // A later turn updates the reactive count in place.
    rerender(<ChatContextDetails completedCompactions={2} />);
    expect(details).toHaveTextContent("Completed compactions2");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("opens by tap and never reads an unrecorded count as zero", async () => {
    const user = userEvent.setup();
    render(<ChatContextDetails completedCompactions={undefined} />);

    await user.click(trigger()!);

    const details = screen.getByRole("dialog", { name: "Agent context" });
    expect(details).toHaveTextContent("Completed compactionsUnavailable");
    expect(details).toHaveTextContent(
      "No compaction count has been recorded for this chat.",
    );
    expect(details).not.toHaveTextContent("0");
  });
});
