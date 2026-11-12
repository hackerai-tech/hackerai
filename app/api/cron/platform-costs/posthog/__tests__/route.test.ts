/** @jest-environment node */
import { GET } from "../route";
import {
  fetchWithRetry,
  isAuthorizedCronRequest,
  replaceCostWindow,
} from "@/lib/billing/platform-cost-sync";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
}));
jest.mock("@/lib/billing/platform-cost-sync", () => ({
  fetchWithRetry: jest.fn(),
  isAuthorizedCronRequest: jest.fn(),
  replaceCostWindow: jest.fn(),
  logCostSync: jest.fn(),
  requireEnvironment: (name: string) => {
    if (!process.env[name]) throw new Error("Missing config");
    return process.env[name];
  },
}));

const original = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-11-12T18:00:00Z"));
  jest.mocked(isAuthorizedCronRequest).mockReturnValue(true);
  process.env.POSTHOG_BILLING_READ_TOKEN = "test-reader";
  process.env.POSTHOG_BILLING_ORGANIZATION_ID =
    "00000000-0000-0000-0000-000000000001";
  process.env.POSTHOG_BILLING_PROJECT_IDS = "12,34";
});
afterEach(() => {
  process.env = { ...original };
  jest.useRealTimers();
});

test("unauthorized and unconfigured jobs cannot replace operating costs", async () => {
  jest.mocked(isAuthorizedCronRequest).mockReturnValueOnce(false);
  expect((await GET(new Request("https://example.test"))).status).toBe(401);
  delete process.env.POSTHOG_BILLING_READ_TOKEN;
  expect((await GET(new Request("https://example.test"))).status).toBe(503);
  expect(fetchWithRetry).not.toHaveBeenCalled();
  expect(replaceCostWindow).not.toHaveBeenCalled();
});

test("partial provider response leaves persisted costs intact", async () => {
  jest
    .mocked(fetchWithRetry)
    .mockImplementationOnce(async (_url, _init, consume) =>
      consume(
        Response.json({
          status: "ok",
          results: [{ data: [1], dates: ["2026-11-05"] }],
        }),
      ),
    );
  expect((await GET(new Request("https://example.test"))).status).toBe(500);
  expect(replaceCostWindow).not.toHaveBeenCalled();
});

test("reconciles complete UTC days under the explicit organization and project scope", async () => {
  jest
    .mocked(fetchWithRetry)
    .mockImplementationOnce(async (_url, _init, consume) =>
      consume(
        Response.json({
          status: "ok",
          results: [
            {
              dates: Array.from(
                { length: 7 },
                (_, i) => `2026-11-${String(i + 5).padStart(2, "0")}`,
              ),
              data: [1, 2, 3, 4, 5, 6, 0],
            },
          ],
        }),
      ),
    );
  jest.mocked(replaceCostWindow).mockResolvedValueOnce({
    inserted: 7,
    updated: 0,
    deleted: 0,
    unchanged: 0,
  });
  expect((await GET(new Request("https://example.test"))).status).toBe(200);
  const url = new URL(jest.mocked(fetchWithRetry).mock.calls[0][0]);
  expect(url.pathname).toBe(
    "/api/organizations/00000000-0000-0000-0000-000000000001/billing/spend/timeseries/",
  );
  expect(url.searchParams.get("team_ids")).toBe("12,34");
  expect(replaceCostWindow).toHaveBeenCalledWith(
    expect.objectContaining({
      vendor: "posthog",
      startDay: "2026-11-05",
      endDay: "2026-11-11",
      rows: expect.arrayContaining([
        expect.objectContaining({
          costStatus: "estimated",
          effectiveCostDollars: 0,
        }),
      ]),
    }),
  );
});
