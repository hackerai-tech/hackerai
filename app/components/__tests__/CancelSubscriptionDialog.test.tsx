import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PAID_FUNNEL_EVENTS } from "@/lib/analytics/paid-funnel";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockCancelSubscription = jest.fn();
const mockGetRetentionOffers = jest.fn();
const mockPauseSubscription = jest.fn();
const mockAcceptRetentionDiscount = jest.fn();
const mockCaptureAuthenticatedEvent = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: "pro",
  }),
}));

jest.mock("@/lib/billing/client", () => ({
  cancelSubscription: mockCancelSubscription,
  getRetentionOffers: mockGetRetentionOffers,
  pauseSubscription: mockPauseSubscription,
  acceptRetentionDiscount: mockAcceptRetentionDiscount,
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: mockToastSuccess,
  },
}));

const CancelSubscriptionDialog = require("../CancelSubscriptionDialog")
  .default as typeof import("../CancelSubscriptionDialog").default;

const PAUSE_EFFECTIVE_AT = Date.UTC(2026, 9, 1, 12);
const PAUSE_RESUME_AT = Date.UTC(2026, 11, 1, 12);

function retentionOffers(
  overrides: { pause?: boolean; discount?: boolean } = {},
) {
  const pause = overrides.pause ?? true;
  const discount = overrides.discount ?? true;
  return {
    offersEnabled: true,
    subscriptionTier: "pro-plus",
    plan: "pro-plus-monthly-plan",
    pause: {
      eligible: pause,
      pauseEffectiveAt: PAUSE_EFFECTIVE_AT,
      options: pause
        ? [
            { months: 1, resumeAt: Date.UTC(2026, 10, 1, 12) },
            { months: 2, resumeAt: PAUSE_RESUME_AT },
            { months: 3, resumeAt: Date.UTC(2027, 0, 1, 12) },
          ]
        : [],
    },
    discount: {
      eligible: discount,
      percentOff: 50,
      durationMonths: 2,
      currentAmountDollars: 60,
      discountedAmountDollars: 30,
      currency: "usd",
      nextRenewalAt: PAUSE_EFFECTIVE_AT,
    },
  };
}

async function completeSurvey(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: /not using it enough/i }));
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(
    screen.getByRole("radio", {
      name: /too expensive for how often i use it/i,
    }),
  );
  await user.type(
    screen.getByLabelText("Tell us a little more"),
    "Busy with a contract for a while",
  );
  await user.click(screen.getByRole("button", { name: "Next" }));
}

describe("CancelSubscriptionDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRetentionOffers.mockResolvedValue(
      retentionOffers({ pause: false, discount: false }) as never,
    );
  });

  it("shows usage limits as a cancellation reason", () => {
    render(<CancelSubscriptionDialog open={true} onOpenChange={jest.fn()} />);

    expect(
      screen.getByRole("radio", { name: /hit usage limits too often/i }),
    ).toBeInTheDocument();
  });

  it("shows structured follow-ups for the selected reason", async () => {
    const user = userEvent.setup();
    render(<CancelSubscriptionDialog open={true} onOpenChange={jest.fn()} />);

    await user.click(screen.getByRole("radio", { name: /missing feature/i }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(
      screen.getByRole("radio", {
        name: /a capability i need is missing/i,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("radio", {
        name: /agent used the wrong execution environment/i,
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("radio", { name: /billing or renewal issue/i }),
    ).not.toBeInTheDocument();
  });

  it("confirms that retries stopped when a past-due subscription is canceled immediately", async () => {
    const onCancellationCompleted = jest.fn();
    mockCancelSubscription.mockResolvedValue({
      canceled: true,
      cancelAtPeriodEnd: false,
      alreadyScheduled: false,
    } as never);
    const user = userEvent.setup();

    render(
      <CancelSubscriptionDialog
        open={true}
        onOpenChange={jest.fn()}
        onCancellationCompleted={onCancellationCompleted}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /other/i }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(
      screen.getByRole("radio", { name: /a billing or renewal issue/i }),
    );
    await user.type(
      screen.getByLabelText("Tell us a little more"),
      "The renewal failed",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Confirm & Cancel" }));

    expect(mockCancelSubscription).toHaveBeenCalledWith({
      cancellationReason: {
        reasonCategory: "other",
        reasonSubcategory: "billing_or_renewal",
        reasonDetails: "The renewal failed",
      },
    });

    expect(
      await screen.findByRole("heading", { name: "Subscription canceled" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Your Pro subscription is canceled. We won't retry the failed renewal payment.",
      ),
    ).toBeVisible();
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Subscription canceled. Payment retries stopped.",
    );
    expect(onCancellationCompleted).toHaveBeenCalledWith({
      cancelAtPeriodEnd: false,
      currentPeriodEnd: undefined,
      alreadyScheduled: false,
    });
  });

  it("offers a pause and schedules it for the selected duration", async () => {
    mockGetRetentionOffers.mockResolvedValue(retentionOffers() as never);
    mockPauseSubscription.mockResolvedValue({
      paused: true,
      months: 2,
      pauseEffectiveAt: PAUSE_EFFECTIVE_AT,
      resumeAt: PAUSE_RESUME_AT,
      alreadyScheduled: false,
    } as never);
    const onPauseScheduled = jest.fn();
    const user = userEvent.setup();

    render(
      <CancelSubscriptionDialog
        open={true}
        onOpenChange={jest.fn()}
        onPauseScheduled={onPauseScheduled}
      />,
    );

    await completeSurvey(user);

    expect(
      await screen.findByRole("heading", { name: "Before you cancel" }),
    ).toBeVisible();
    expect(mockGetRetentionOffers).toHaveBeenCalledWith({
      reasonCategory: "not_using_enough",
    });
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionOfferImpressed,
      expect.objectContaining({
        offers_shown: ["pause", "discount"],
        reason_category: "not_using_enough",
      }),
    );
    expect(mockCancelSubscription).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "2 months" }));
    await user.click(
      screen.getByRole("button", { name: "Pause for 2 months" }),
    );

    expect(mockPauseSubscription).toHaveBeenCalledWith({
      months: 2,
      cancellationReason: {
        reasonCategory: "not_using_enough",
        reasonSubcategory: "too_expensive_low_frequency",
        reasonDetails: "Busy with a contract for a while",
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Pause scheduled" }),
    ).toBeVisible();
    expect(onPauseScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ months: 2, resumeAt: PAUSE_RESUME_AT }),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Pause scheduled");
  });

  it("applies the retention discount from the offer step", async () => {
    mockGetRetentionOffers.mockResolvedValue(
      retentionOffers({ pause: false }) as never,
    );
    mockAcceptRetentionDiscount.mockResolvedValue({
      applied: true,
      percentOff: 50,
      durationMonths: 2,
      currentAmountDollars: 60,
      discountedAmountDollars: 30,
      currency: "usd",
      nextRenewalAt: PAUSE_EFFECTIVE_AT,
    } as never);
    const onDiscountApplied = jest.fn();
    const user = userEvent.setup();

    render(
      <CancelSubscriptionDialog
        open={true}
        onOpenChange={jest.fn()}
        onDiscountApplied={onDiscountApplied}
      />,
    );

    await completeSurvey(user);

    expect(
      await screen.findByRole("heading", { name: "Stay for 50% off" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Pause your plan" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Apply 50% off" }));

    expect(mockAcceptRetentionDiscount).toHaveBeenCalledWith({
      cancellationReason: {
        reasonCategory: "not_using_enough",
        reasonSubcategory: "too_expensive_low_frequency",
        reasonDetails: "Busy with a contract for a while",
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Discount applied" }),
    ).toBeVisible();
    expect(onDiscountApplied).toHaveBeenCalledWith(
      expect.objectContaining({ percentOff: 50, durationMonths: 2 }),
    );
    expect(mockCancelSubscription).not.toHaveBeenCalled();
  });

  it("continues to the cancellation confirmation when offers are declined", async () => {
    mockGetRetentionOffers.mockResolvedValue(retentionOffers() as never);
    const user = userEvent.setup();

    render(<CancelSubscriptionDialog open={true} onOpenChange={jest.fn()} />);

    await completeSurvey(user);
    await screen.findByRole("heading", { name: "Before you cancel" });
    await user.click(
      screen.getByRole("button", { name: "No thanks, continue to cancel" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Are you sure you want to cancel?",
      }),
    ).toBeVisible();
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      PAID_FUNNEL_EVENTS.retentionOfferDeclined,
      expect.objectContaining({ offers_shown: ["pause", "discount"] }),
    );
  });

  it("skips the offer step when offers cannot be loaded", async () => {
    mockGetRetentionOffers.mockRejectedValue(new Error("offline") as never);
    const user = userEvent.setup();

    render(<CancelSubscriptionDialog open={true} onOpenChange={jest.fn()} />);

    await completeSurvey(user);

    expect(
      await screen.findByRole("heading", {
        name: "Are you sure you want to cancel?",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Before you cancel" }),
    ).not.toBeInTheDocument();
  });
});
