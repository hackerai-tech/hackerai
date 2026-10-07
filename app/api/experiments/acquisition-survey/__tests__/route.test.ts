import { surveyDefinition } from "@/lib/analytics/test-support/acquisition-survey-fixture";
const mockGetUserIDAndPro = jest.fn();
const mockArePostHogSurveyFlagsEnabled = jest.fn();
const mockFetch = jest.fn();
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { headers?: Record<string, string> }) => ({
      json: async () => body,
      headers: new Headers(init?.headers),
    }),
  },
}));
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: (...args: unknown[]) => mockGetUserIDAndPro(...args),
}));
jest.mock("@/lib/posthog/server", () => ({
  arePostHogSurveyFlagsEnabled: (...args: unknown[]) =>
    mockArePostHogSurveyFlagsEnabled(...args),
}));
import { GET } from "../route";
const request = {} as Parameters<typeof GET>[0];
describe("GET /api/experiments/acquisition-survey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user-1",
      subscription: "free",
    });
    mockArePostHogSurveyFlagsEnabled.mockResolvedValue(true);
    global.fetch = mockFetch;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        surveys: [{ ...surveyDefinition, start_date: "2020-01-01T00:00:00Z" }],
      }),
    });
  });
  it("returns real question IDs only when every audience flag matches", async () => {
    const response = await GET(request);
    expect(await response.json()).toEqual({
      available: true,
      survey: {
        id: surveyDefinition.id,
        questionId: surveyDefinition.questions[0].id,
      },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockArePostHogSurveyFlagsEnabled).toHaveBeenCalledWith(
      ["hac-57-post-activation-survey", "survey-targeting-test"],
      "user-1",
    );
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "https://us.i.posthog.com/api/surveys/?token=phc_test",
    );
  });
  it.each([
    { subscription: "pro" },
    { subscription: "free", organizationId: "org" },
  ])(
    "does not fetch research configuration for excluded accounts (%j)",
    async (user) => {
      mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1", ...user });
      expect(await (await GET(request)).json()).toEqual({ available: false });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockArePostHogSurveyFlagsEnabled).not.toHaveBeenCalled();
    },
  );
  it("fails closed for auth, network, configuration and targeting failures", async () => {
    mockGetUserIDAndPro.mockRejectedValueOnce(new Error("unauthorized"));
    expect(await (await GET(request)).json()).toEqual({ available: false });
    mockFetch.mockRejectedValueOnce(new Error("timeout"));
    expect(await (await GET(request)).json()).toEqual({ available: false });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ surveys: [] }),
    });
    expect(await (await GET(request)).json()).toEqual({ available: false });
    mockArePostHogSurveyFlagsEnabled.mockResolvedValueOnce(false);
    expect(await (await GET(request)).json()).toEqual({ available: false });
  });
});
