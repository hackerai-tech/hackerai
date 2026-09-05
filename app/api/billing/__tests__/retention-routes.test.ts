import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";

const mockGetRetentionOffers = jest.fn();
const mockPauseSubscription = jest.fn();
const mockResumeSubscription = jest.fn();

jest.mock("@/lib/actions/retention-offers", () => ({
  __esModule: true,
  default: mockGetRetentionOffers,
}));

jest.mock("@/lib/actions/pause-subscription", () => ({
  __esModule: true,
  default: mockPauseSubscription,
}));

jest.mock("@/lib/actions/resume-subscription", () => ({
  __esModule: true,
  default: mockResumeSubscription,
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { flush: jest.fn(), event: jest.fn() },
}));

jest.mock("next/server", () => ({
  after: jest.fn((callback: () => void) => callback()),
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

function request(body: unknown) {
  return {
    json: async () => body,
  };
}

const cancellationReason = {
  reasonCategory: "not_using_enough",
  reasonSubcategory: "too_expensive_low_frequency",
  reasonDetails: "Travelling",
};

describe("retention offer API routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("previews retention offers for a reason", async () => {
    mockGetRetentionOffers.mockResolvedValue({
      offersEnabled: true,
      pause: { eligible: true, options: [] },
    } as never);
    const { POST } = await import("../retention-offers/route");

    const response = await POST(
      request({ reasonCategory: "not_using_enough" }) as never,
    );

    expect(response.status).toBe(200);
    expect(mockGetRetentionOffers).toHaveBeenCalledWith({
      reasonCategory: "not_using_enough",
    });
  });

  it("maps a missing reason to a 400 for offers", async () => {
    mockGetRetentionOffers.mockRejectedValue(
      new Error("Please select the main cancellation reason") as never,
    );
    const { POST } = await import("../retention-offers/route");

    const response = await POST(request(null) as never);

    expect(response.status).toBe(400);
  });

  it("passes the pause duration and survey answers to the action", async () => {
    mockPauseSubscription.mockResolvedValue({
      paused: true,
      months: 2,
      pauseEffectiveAt: 1,
      resumeAt: 2,
      alreadyScheduled: false,
    } as never);
    const { POST } = await import("../pause/route");

    const response = await POST(
      request({ months: 2, cancellationReason }) as never,
    );

    expect(response.status).toBe(200);
    expect(mockPauseSubscription).toHaveBeenCalledWith({
      months: 2,
      cancellationReason,
    });
  });

  it("rejects a pause without a survey payload", async () => {
    const { POST } = await import("../pause/route");

    const response = await POST(request({ months: 1 }) as never);

    expect(response.status).toBe(400);
    expect(mockPauseSubscription).not.toHaveBeenCalled();
  });

  it("maps offer ineligibility to a 400", async () => {
    mockPauseSubscription.mockRejectedValue(
      new Error(BILLING_ERRORS.retentionOfferUnavailable) as never,
    );
    const { POST } = await import("../pause/route");

    const response = await POST(
      request({ months: 1, cancellationReason }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: BILLING_ERRORS.retentionOfferUnavailable,
    });
  });

  it("resumes a paused plan and maps payment failures to 402", async () => {
    mockResumeSubscription.mockResolvedValue({
      resumed: true,
      stripeSubscriptionId: "sub_new",
      alreadyActive: false,
    } as never);
    const { POST } = await import("../resume/route");

    const response = await POST();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resumed: true,
      stripeSubscriptionId: "sub_new",
      alreadyActive: false,
    });

    mockResumeSubscription.mockRejectedValue(
      new Error(BILLING_ERRORS.resumePaymentFailed) as never,
    );
    const failed = await POST();
    expect(failed.status).toBe(402);
  });
});
