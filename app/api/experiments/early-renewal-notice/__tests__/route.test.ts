/**
 * @jest-environment node
 */
const mockGetUserIDAndPro = jest.fn();
const mockFlag = jest.fn();
const mockPostHogClient = jest.fn();

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: (...args: unknown[]) => mockGetUserIDAndPro(...args),
}));
jest.mock("@/lib/posthog/flag-assignment", () => ({
  getPostHogFlagWithoutExposure: (...args: unknown[]) => mockFlag(...args),
}));
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => mockPostHogClient(),
}));

import { GET } from "../route";

const request = {} as Parameters<typeof GET>[0];
const posthog = { getFeatureFlagResult: jest.fn() };

async function enabled() {
  const response = await GET(request);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return ((await response.json()) as { enabled: unknown }).enabled;
}

describe("GET /api/experiments/early-renewal-notice", () => {
  beforeEach(() => {
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_a",
      subscription: "pro",
    });
    mockPostHogClient.mockReturnValue(posthog);
    mockFlag.mockResolvedValue(true);
  });

  it("evaluates the flag for the authenticated user without exposure", async () => {
    expect(await enabled()).toBe(true);
    expect(mockFlag).toHaveBeenCalledWith(
      posthog,
      "early-renewal-payment-notice",
      "user_a",
    );
  });

  it("still evaluates a past-due subscriber whose entitlement dropped to free", async () => {
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_a",
      subscription: "free",
    });
    expect(await enabled()).toBe(true);
  });

  it("keeps team accounts off without evaluating the flag", async () => {
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_a",
      subscription: "team",
    });
    expect(await enabled()).toBe(false);
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it.each([
    ["the flag is off", () => mockFlag.mockResolvedValue(false)],
    ["the flag is missing", () => mockFlag.mockResolvedValue(undefined)],
    ["evaluation fails", () => mockFlag.mockRejectedValue(new Error("down"))],
    [
      "PostHog is not configured",
      () => mockPostHogClient.mockReturnValue(null),
    ],
    [
      "the user is not signed in",
      () => mockGetUserIDAndPro.mockRejectedValue(new Error("unauthorized")),
    ],
  ])("defaults off when %s", async (_, arrange) => {
    arrange();
    expect(await enabled()).toBe(false);
  });
});
