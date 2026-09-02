const fetchWithRetryMock = jest.fn();
const logCostSyncMock = jest.fn();
const replaceCostWindowMock = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

jest.mock("@/lib/billing/platform-cost-sync", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  isAuthorizedCronRequest: () => true,
  logCostSync: (...args: unknown[]) => logCostSyncMock(...args),
  replaceCostWindow: (...args: unknown[]) => replaceCostWindowMock(...args),
  requireEnvironment: (name: string) => `${name.toLowerCase()}-value`,
  safeError: (error: unknown) => ({
    error_name: error instanceof Error ? error.name : "UnknownError",
    error_message: error instanceof Error ? error.message : "Unknown error",
  }),
}));

import { GET } from "../route";

const charge = (day: string) => ({
  BilledCost: 1,
  EffectiveCost: 1,
  BillingCurrency: "USD",
  ChargeCategory: "Usage",
  ChargePeriodStart: `${day}T00:00:00.000Z`,
  ChargePeriodEnd: `${day}T23:59:59.999Z`,
  ConsumedQuantity: 1,
  ConsumedUnit: "GB-hours",
  ServiceName: `service-${day}`,
  ServiceCategory: "Compute",
});

const billingResponse = (...days: string[]) => {
  const payload = new TextEncoder().encode(
    days.map((day) => JSON.stringify(charge(day))).join("\n"),
  );
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    }),
  } as Response;
};

const cronRequest = (requestId: string) =>
  ({
    headers: {
      get: (name: string) => (name === "x-vercel-id" ? requestId : null),
    },
  }) as Request;

describe("Vercel platform cost sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-09-02T17:00:00.000Z"));
    replaceCostWindowMock.mockResolvedValue({
      inserted: 1,
      updated: 0,
      deleted: 0,
      unchanged: 0,
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it("excludes upstream boundary rows before replacing the completed window", async () => {
    fetchWithRetryMock.mockImplementation(
      async (
        _url: string,
        _init: RequestInit,
        consume: (response: Response) => Promise<unknown>,
      ) => consume(billingResponse("2026-07-28", "2026-09-01", "2026-09-02")),
    );

    const response = await GET(cronRequest("iad1::request-1"));

    expect(response.status).toBe(200);
    expect(replaceCostWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startDay: "2026-07-29",
        endDay: "2026-09-01",
        rows: [expect.objectContaining({ day: "2026-09-01" })],
      }),
    );
    expect(logCostSyncMock).toHaveBeenCalledWith(
      "warn",
      "platform_cost_sync_rows_excluded_outside_window",
      expect.objectContaining({
        excluded_row_count: 2,
        excluded_before_start: 1,
        excluded_after_end: 1,
      }),
    );
  });

  it("fails closed when every returned row is outside the requested window", async () => {
    fetchWithRetryMock.mockImplementation(
      async (
        _url: string,
        _init: RequestInit,
        consume: (response: Response) => Promise<unknown>,
      ) => consume(billingResponse("2026-07-28", "2026-09-02")),
    );

    const response = await GET(cronRequest("iad1::request-2"));

    expect(response.status).toBe(500);
    expect(replaceCostWindowMock).not.toHaveBeenCalled();
    expect(logCostSyncMock).toHaveBeenCalledWith(
      "error",
      "platform_cost_sync_failed",
      expect.objectContaining({
        stage: "normalize",
        error_message:
          "Vercel billing response contains no rows inside the requested window",
      }),
    );
  });

  it("preserves an authoritative empty response for window cleanup", async () => {
    fetchWithRetryMock.mockImplementation(
      async (
        _url: string,
        _init: RequestInit,
        consume: (response: Response) => Promise<unknown>,
      ) => consume(billingResponse()),
    );

    const response = await GET(cronRequest("iad1::request-3"));

    expect(response.status).toBe(200);
    expect(replaceCostWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [] }),
    );
    expect(logCostSyncMock).not.toHaveBeenCalledWith(
      "warn",
      "platform_cost_sync_rows_excluded_outside_window",
      expect.anything(),
    );
  });
});
