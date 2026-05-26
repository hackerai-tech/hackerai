import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockUseAuth = jest.fn();
const mockUseQuery = jest.fn();
const mockGetOrCreateReferralCode = jest.fn();
const mockCaptureAuthenticatedEvent = jest.fn();
const mockIsFeatureEnabled = jest.fn();
const mockOnFeatureFlags = jest.fn();
const mockToastError = jest.fn();

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  __esModule: true,
  useAuth: () => mockUseAuth(),
}));

jest.mock("convex/react", () => ({
  __esModule: true,
  useMutation: () => mockGetOrCreateReferralCode,
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    referrals: {
      getOrCreateReferralCode: "referrals.getOrCreateReferralCode",
      getReferralSummary: "referrals.getReferralSummary",
    },
  },
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) =>
    mockCaptureAuthenticatedEvent(...args),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    __loaded: true,
    isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
    onFeatureFlags: (...args: unknown[]) => mockOnFeatureFlags(...args),
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn(() => Promise.resolve()),
  },
});

describe("ReferralRewardEntry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      user: { id: "user-123", email: "user@example.com" },
    });
    mockUseQuery.mockReturnValue({
      code: "ABCD1234",
      balanceCredits: 10,
      signedUp: 2,
      activated: 1,
      converted: 1,
    });
    mockGetOrCreateReferralCode.mockResolvedValue({ code: "ABCD1234" });
    mockIsFeatureEnabled.mockReturnValue(true);
    mockOnFeatureFlags.mockImplementation((callback: () => void) => {
      callback();
    });
  });

  it("renders the sidebar referral action for free users when the flag is enabled", async () => {
    const { ReferralRewardEntryContent } = require("../ReferralRewardDialog");
    render(
      <ReferralRewardEntryContent
        isCollapsed={false}
        isFreeUser={true}
        enabled={true}
        userId="user-123"
      />,
    );

    expect(await screen.findByTestId("referral-button")).toBeInTheDocument();
    expect(screen.getByText("Share HackerAI")).toBeInTheDocument();
    expect(
      screen.getByText("Earn credits per paid referral"),
    ).toBeInTheDocument();
  });

  it("does not render for paid users", () => {
    const { ReferralRewardEntryContent } = require("../ReferralRewardDialog");
    render(
      <ReferralRewardEntryContent
        isCollapsed={false}
        isFreeUser={false}
        enabled={true}
        userId="user-123"
      />,
    );

    expect(screen.queryByTestId("referral-button")).not.toBeInTheDocument();
  });

  it("does not render when the experiment flag is disabled", async () => {
    const { ReferralRewardEntryContent } = require("../ReferralRewardDialog");
    render(
      <ReferralRewardEntryContent
        isCollapsed={false}
        isFreeUser={true}
        enabled={false}
        userId="user-123"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("referral-button")).not.toBeInTheDocument();
    });
  });

  it("opens the modal, shows stats, and copies the invite link", async () => {
    const { ReferralRewardEntryContent } = require("../ReferralRewardDialog");
    render(
      <ReferralRewardEntryContent
        isCollapsed={false}
        isFreeUser={true}
        enabled={true}
        userId="user-123"
      />,
    );

    fireEvent.click(await screen.findByTestId("referral-button"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("referral-link")).toHaveTextContent(
      "/invite/ABCD1234",
    );
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("Signed up")).toBeInTheDocument();
    expect(screen.getByText("Activated")).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Copy referral link"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("/invite/ABCD1234"),
      );
    });
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "referral_invite_copied",
      { referral_code: "ABCD1234" },
    );
  });
});
