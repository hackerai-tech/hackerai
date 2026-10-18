import { evaluateRegionalPaywall } from "../regional-paywall.server";

jest.mock("@/app/posthog", () => ({ __esModule: true, default: () => null }));
const getFeatureFlagResult = jest.fn();
const posthog = { getFeatureFlagResult };
const assignment = { variant: "test", country: "IN" } as const;

beforeEach(() => jest.resetAllMocks());

it.each(["control", "test"])(
  "assigns %s by authenticated account without exposure",
  async (variant) => {
    getFeatureFlagResult.mockResolvedValue({ enabled: true, variant });
    expect(
      await evaluateRegionalPaywall({ userId: "user-1", assignment, posthog }),
    ).toBe(variant);
    expect(getFeatureFlagResult).toHaveBeenCalledWith(
      "regional-paywall-v2",
      "user-1",
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          subscription: "free",
          regional_subscription_country: "IN",
        },
      },
    );
  },
);

it.each([undefined, { variant: "control", country: "IN" } as const])(
  "does not enroll accounts without the paid regional requirement",
  async (assignment) => {
    expect(
      await evaluateRegionalPaywall({ userId: "user-1", assignment, posthog }),
    ).toBeNull();
    expect(getFeatureFlagResult).not.toHaveBeenCalled();
  },
);

it.each([
  undefined,
  { enabled: false, variant: "test" },
  { enabled: true, variant: "unexpected" },
])("falls back without recording a fabricated assignment", async (result) => {
  getFeatureFlagResult.mockResolvedValue(result);
  expect(
    await evaluateRegionalPaywall({ userId: "user-1", assignment, posthog }),
  ).toBeNull();
});

it("keeps presentation failures independent of access", async () => {
  getFeatureFlagResult.mockRejectedValue(new Error("Unavailable"));
  expect(
    await evaluateRegionalPaywall({ userId: "user-1", assignment, posthog }),
  ).toBeNull();
  expect(assignment.variant).toBe("test");
});
