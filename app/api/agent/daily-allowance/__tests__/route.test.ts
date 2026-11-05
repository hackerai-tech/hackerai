import type { NextRequest } from "next/server";
import { GET } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { limitPaidBucket } from "@/lib/rate-limit/paid-bucket";
import { getPaidDailyFreeAllowanceStatus } from "@/lib/rate-limit/paid-daily-free-allowance";
import { ChatSDKError } from "@/lib/errors";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: init?.headers,
    }),
  },
}));
jest.mock("@/lib/auth/get-user-id");
jest.mock("@/lib/rate-limit/redis");
jest.mock("@/lib/rate-limit/paid-bucket");
jest.mock("@/lib/rate-limit/token-bucket", () => ({
  getBudgetLimits: () => ({ monthly: 1000 }),
  getMonthlyBucketKey: (id: string, tier: string) => `${id}:${tier}`,
}));
jest.mock("@/lib/rate-limit/paid-daily-free-allowance", () => ({
  getPaidDailyFreeAllowanceStatus: jest.fn(),
  paidDailyFreeAllowanceStatusToMetadata: (value: unknown) => value,
}));
const auth = jest.mocked(getUserIDAndPro);
const allowance = jest.mocked(getPaidDailyFreeAllowanceStatus);
const monthly = jest.mocked(limitPaidBucket);
const req = {} as NextRequest;
beforeEach(() => {
  jest.resetAllMocks();
  auth.mockResolvedValue({
    userId: "owner",
    subscription: "pro",
    emailVerified: true,
  });
  jest.mocked(createRedisClient).mockReturnValue({ eval: jest.fn() } as never);
  monthly.mockResolvedValue({
    success: true,
    remaining: 0,
    reset: 123,
    limit: 1000,
  });
  allowance.mockResolvedValue({
    available: true,
    costRemainingDollars: 0.12,
  } as never);
});
it("uses session identity and a zero-debit monthly check without reserving allowance", async () => {
  const response = await GET(req);
  expect(response.status).toBe(200);
  expect(monthly).toHaveBeenCalledWith(expect.anything(), "owner:pro", 1000, 0);
  expect(allowance).toHaveBeenCalledWith({
    userId: "owner",
    subscription: "pro",
    mode: "agent",
    selectedModel: "auto",
    capReason: "monthly_exhausted",
  });
  expect(await response.json()).toEqual({
    available: true,
    costRemainingDollars: 0.12,
  });
  expect(response.headers).toEqual({ "Cache-Control": "no-store" });
});
it("does not declare exhaustion after monthly usage is restored", async () => {
  monthly.mockResolvedValue({
    success: true,
    remaining: 50,
    reset: 123,
    limit: 1000,
  });
  await GET(req);
  expect(allowance).toHaveBeenCalledWith(
    expect.objectContaining({ capReason: undefined }),
  );
});
it.each(["free", "team"] as const)(
  "does not query personal allowances for %s",
  async (subscription) => {
    auth.mockResolvedValue({
      userId: "owner",
      subscription,
      emailVerified: true,
    });
    expect(await (await GET(req)).json()).toEqual({ available: false });
    expect(monthly).not.toHaveBeenCalled();
    expect(allowance).not.toHaveBeenCalled();
  },
);
it("fails closed when usage cannot be checked", async () => {
  monthly.mockRejectedValue(new Error("Redis unavailable"));
  expect((await GET(req)).status).toBe(503);
  expect(allowance).not.toHaveBeenCalled();
});
it("rejects unauthenticated requests", async () => {
  const error = new ChatSDKError("unauthorized:auth");
  const response = { status: 401 } as Response;
  jest.spyOn(error, "toResponse").mockReturnValue(response);
  auth.mockRejectedValue(error);
  expect(await GET(req)).toBe(response);
  expect(monthly).not.toHaveBeenCalled();
});
it("preserves exhausted or already reserved allowance status", async () => {
  allowance.mockResolvedValue({
    available: false,
    unavailableReason: "request_in_progress",
  } as never);
  expect(await (await GET(req)).json()).toEqual({
    available: false,
    unavailableReason: "request_in_progress",
  });
});
