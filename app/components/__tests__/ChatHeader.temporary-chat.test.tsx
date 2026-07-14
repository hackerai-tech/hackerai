import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

let mockSubscription: "free" | "pro" = "free";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    toggleChatSidebar: jest.fn(),
    subscription: mockSubscription,
    isCheckingProPlan: false,
    initializeNewChat: jest.fn(),
    closeSidebar: jest.fn(),
    setChatSidebarOpen: jest.fn(),
    temporaryChatsEnabled: false,
    setTemporaryChatsEnabled: jest.fn(),
  }),
}));

jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));

jest.mock("@/app/hooks/useTauri", () => ({
  navigateToAuth: jest.fn(),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureUpgradeCtaImpression: jest.fn(),
}));

const ChatHeader = require("../ChatHeader")
  .default as typeof import("../ChatHeader").default;

describe("ChatHeader temporary chat entitlement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscription = "free";
    jest.mocked(useAuth).mockReturnValue({
      user: { id: "user_123" },
      loading: false,
    } as ReturnType<typeof useAuth>);
  });

  it("hides the temporary chat toggle from free users", () => {
    render(<ChatHeader hasMessages={false} hasActiveChat={false} />);

    expect(
      screen.queryByRole("button", {
        name: "Toggle temporary chats for new chats",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps the temporary chat toggle available to paid users", () => {
    mockSubscription = "pro";

    render(<ChatHeader hasMessages={false} hasActiveChat={false} />);

    expect(
      screen.getAllByRole("button", {
        name: "Toggle temporary chats for new chats",
      }),
    ).toHaveLength(2);
  });
});
