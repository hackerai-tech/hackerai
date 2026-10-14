import type { NextRequest } from "next/server";
import {
  freeAgentDailyCountryFromRequest,
  getFreeAgentDailyStatus,
  enforceFreeAgentDailyStatus,
  recordFreeAgentDailyCompletion,
} from "../free-agent-completed-daily.server";

const mockFlag = jest.fn();
const mockCapture = jest.fn();
const mockFlush = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({
    getFeatureFlagResult: mockFlag,
    capture: mockCapture,
    flush: mockFlush,
  }),
}));
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({ get: mockGet, set: mockSet }),
}));
const input = {
  userId: "user",
  quotaSubject: "account",
  subscription: "free",
  country: "US",
};
const completion = {
  assignment: { variant: "test" as const },
  quotaSubject: "account",
  outcome: "success",
  finishReason: "stop",
  hasResponseContent: true,
  truncated: false,
};
const originalVercel = process.env.VERCEL;
beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-10-14T23:59:00Z"));
  process.env.VERCEL = "1";
  mockFlag.mockResolvedValue({ enabled: true, variant: "test" });
  mockGet.mockResolvedValue(null);
  mockFlush.mockResolvedValue(undefined);
  mockSet.mockResolvedValue("OK");
});
afterEach(() => {
  jest.useRealTimers();
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
});
const request = (country?: string, consent?: string) =>
  ({
    headers: new Headers(country ? { "x-vercel-ip-country": country } : {}),
    cookies: { get: () => (consent ? { value: consent } : undefined) },
  }) as unknown as NextRequest;
it("only trusts supported ingress and consent", () => {
  expect(freeAgentDailyCountryFromRequest(request("US"))).toBe("US");
  expect(freeAgentDailyCountryFromRequest(request("DE"))).toBeUndefined();
  expect(freeAgentDailyCountryFromRequest(request("DE", "accepted"))).toBe(
    "DE",
  );
  expect(
    freeAgentDailyCountryFromRequest(request("US", "declined")),
  ).toBeUndefined();
  expect(freeAgentDailyCountryFromRequest(request())).toBeUndefined();
  process.env.VERCEL = "0";
  expect(freeAgentDailyCountryFromRequest(request("US"))).toBeUndefined();
});
it.each(["IN", "PK", "BD", "NG", "ID", "IR", "XX", "", undefined])(
  "excludes country %s before assignment",
  async (country) => {
    expect(
      await getFreeAgentDailyStatus({ ...input, country }),
    ).toBeUndefined();
    expect(mockFlag).not.toHaveBeenCalled();
  },
);
it.each(["pro", "pro-plus", "ultra", "team"])(
  "preserves %s regardless of marker",
  async (subscription) => {
    mockGet.mockResolvedValue("1");
    expect(
      await getFreeAgentDailyStatus({ ...input, subscription }),
    ).toBeUndefined();
    expect(mockFlag).not.toHaveBeenCalled();
  },
);
it("does not limit Ask or record assignment lookup as exposure", async () => {
  expect(
    await getFreeAgentDailyStatus({ ...input, mode: "ask" }),
  ).toBeUndefined();
  const status = await getFreeAgentDailyStatus(input);
  expect(status?.completed).toBe(false);
  expect(mockCapture).not.toHaveBeenCalled();
  expect(mockFlag).toHaveBeenCalledWith(
    "free-agent-completed-daily-v1",
    "user",
    expect.objectContaining({ sendFeatureFlagEvents: false }),
  );
});
it("only blocks treatment with a saved completion", async () => {
  for (const variant of ["control", "test"]) {
    mockFlag.mockResolvedValue({ enabled: true, variant });
    mockGet.mockResolvedValue("1");
    const status = await getFreeAgentDailyStatus(input);
    if (variant === "test")
      await expect(
        enforceFreeAgentDailyStatus(status, "user", "agent"),
      ).rejects.toMatchObject({
        statusCode: 429,
        metadata: {
          capReason: "free_agent_daily_completed",
          resetTimestamp: Date.parse("2026-10-15T00:00:00Z"),
        },
      });
    else
      await expect(
        enforceFreeAgentDailyStatus(status, "user", "agent"),
      ).resolves.toBeUndefined();
  }
  mockGet.mockResolvedValue(null);
  await expect(
    enforceFreeAgentDailyStatus(
      await getFreeAgentDailyStatus(input),
      "user",
      "agent",
    ),
  ).resolves.toBeUndefined();
});
it("preserves baseline on disabled flags or dependency failures", async () => {
  for (const result of [
    undefined,
    { enabled: false },
    { enabled: true, variant: "unknown" },
  ]) {
    mockFlag.mockResolvedValue(result);
    expect(await getFreeAgentDailyStatus(input)).toBeUndefined();
  }
  mockFlag.mockRejectedValue(new Error("unavailable"));
  expect(await getFreeAgentDailyStatus(input)).toBeUndefined();
  mockFlag.mockResolvedValue({ enabled: true, variant: "test" });
  mockGet.mockRejectedValue(new Error("unavailable"));
  expect(await getFreeAgentDailyStatus(input)).toBeUndefined();
});
it.each([
  { outcome: "error" },
  { outcome: "aborted" },
  { finishReason: "length" },
  { finishReason: "tool-calls" },
  { hasResponseContent: false },
  { truncated: true },
  { assignment: undefined },
])("does not consume unsuccessful/incomplete response %p", async (override) => {
  await recordFreeAgentDailyCompletion({ ...completion, ...override });
  expect(mockSet).not.toHaveBeenCalled();
});
it("records idempotently on completion day and unlocks at UTC midnight", async () => {
  await recordFreeAgentDailyCompletion(completion);
  await recordFreeAgentDailyCompletion(completion);
  const key = mockSet.mock.calls[0][0];
  expect(mockSet.mock.calls[1][0]).toBe(key);
  expect(mockSet).toHaveBeenCalledWith(key, "1", {
    exat: Date.parse("2026-10-15T00:00:00Z") / 1000,
  });
  jest.setSystemTime(new Date("2026-10-15T00:00:01Z"));
  await getFreeAgentDailyStatus(input);
  expect(mockGet.mock.calls.at(-1)[0]).not.toBe(key);
});
