import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { transferableAbortController } from "node:util";
import { webcrypto } from "node:crypto";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";

const mockGetUserIDAndPro = jest.fn();
const mockGetUser = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockGetOrganization = jest.fn();
const mockListCustomers = jest.fn();
const mockListPrices = jest.fn();
const mockListSubscriptions = jest.fn();
const mockCreatePreview = jest.fn();
const mockUpdateSubscription = jest.fn();
const mockPostHogEvent = jest.fn();
const mockPostHogFlush = jest.fn();
const mockHasActiveSuspensionForUser =
  jest.fn<typeof import("@/lib/suspensions").hasActiveSuspensionForUser>();
const mockGetConvexClient =
  jest.fn<typeof import("@/lib/db/convex-client").getConvexClient>();

jest.mock("next/server", () => ({
  after: jest.fn((callback: () => void) => callback()),
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: mockPostHogEvent,
    flush: mockPostHogFlush,
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/suspensions", () => ({
  hasActiveSuspensionForUser: mockHasActiveSuspensionForUser,
}));

// Only the transport tests below reach these, through the actual suspension helper.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: mockGetConvexClient,
}));
jest.mock("convex/browser", () =>
  jest.requireActual(
    "../../../../node_modules/convex/dist/cjs/browser/index.js",
  ),
);

jest.mock("../../workos", () => ({
  workos: {
    userManagement: {
      getUser: mockGetUser,
      listOrganizationMemberships: mockListOrganizationMemberships,
    },
    organizations: {
      getOrganization: mockGetOrganization,
    },
  },
}));

jest.mock("../../stripe", () => ({
  stripe: {
    customers: {
      list: mockListCustomers,
    },
    prices: {
      list: mockListPrices,
    },
    subscriptions: {
      list: mockListSubscriptions,
      update: mockUpdateSubscription,
    },
    invoices: {
      createPreview: mockCreatePreview,
    },
    products: {
      retrieve: jest.fn(),
    },
  },
}));

function makeRequest(body: Record<string, unknown> = {}) {
  return {
    url: "https://hackerai.example/api/subscription-details",
    headers: new Headers({
      origin: "https://hackerai.example",
      "content-type": "application/json",
    }),
    json: jest.fn().mockResolvedValue(body),
  } as any;
}

/** An active Pro subscription whose Ultra change previews and confirms. */
function arrangeProToUltraChange() {
  mockListPrices.mockResolvedValueOnce({
    data: [
      {
        id: "price_ultra",
        unit_amount: 10000,
        recurring: { interval: "month", interval_count: 1 },
        currency: "usd",
      },
    ],
  } as never);
  mockListSubscriptions.mockResolvedValueOnce({
    data: [
      {
        id: "sub_123",
        metadata: { existing: "metadata" },
        default_payment_method: null,
        items: {
          data: [
            {
              id: "si_123",
              price: {
                id: "price_pro",
                unit_amount: 2000,
                product: "prod_pro",
                recurring: { interval: "month" },
              },
            },
          ],
        },
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
      },
    ],
  } as never);
  mockCreatePreview.mockResolvedValueOnce({
    amount_due: 8000,
    lines: {
      data: [{ amount: 10000 }, { amount: -2000 }],
    },
  } as never);
  mockUpdateSubscription.mockResolvedValueOnce({
    id: "sub_123",
    latest_invoice: null,
  } as never);
}

describe("POST /api/subscription-details", () => {
  it("rejects a sibling-origin plan change before authentication", async () => {
    const request = makeRequest({ plan: "pro-monthly-plan", confirm: true });
    request.headers.set("origin", "https://evil.hackerai.example");
    request.headers.set("content-type", "text/plain");

    const { POST } = await import("../route");
    expect((await POST(request)).status).toBe(403);
    expect(mockGetUserIDAndPro).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockHasActiveSuspensionForUser.mockResolvedValue(false);

    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "team",
      organizationId: "org_team",
    } as never);
    mockGetUser.mockResolvedValue({
      id: "user_123",
      email: "billing@example.com",
    } as never);
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({ id: "org_team" } as never);
    mockListCustomers.mockResolvedValue({
      data: [
        {
          id: "cus_team",
          metadata: { workOSOrganizationId: "org_team" },
        },
      ],
    } as never);
    mockListPrices.mockResolvedValue({
      data: [
        {
          id: "price_team",
          unit_amount: 3000,
        },
      ],
    } as never);
    mockListSubscriptions.mockResolvedValue({ data: [] } as never);
  });

  it.each([28800, 25200])(
    "validates Pro annual price %i before plan preview or changes",
    async (amount) => {
      mockListPrices.mockResolvedValue({
        data: [
          {
            id: "price_pro_yearly",
            lookup_key: "pro-yearly-plan",
            active: true,
            billing_scheme: "per_unit",
            type: "recurring",
            unit_amount: amount,
            currency: "usd",
            recurring: {
              interval: "year",
              interval_count: 1,
              usage_type: "licensed",
            },
          },
        ],
      } as never);
      const { POST } = await import("../route");
      const response = await POST(makeRequest({ plan: "pro-yearly-plan" }));
      expect(response.status).toBe(amount === 28800 ? 200 : 503);
      if (amount === 28800) {
        expect(await response.json()).toMatchObject({ totalDue: 288 });
      } else {
        expect(mockCreatePreview).not.toHaveBeenCalled();
        expect(mockUpdateSubscription).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["pro-plus-monthly-plan", "pro-plus-yearly-plan"])(
    "accepts %s as a target plan",
    async (plan) => {
      const { POST } = await import("../route");

      const response = await POST(makeRequest({ plan }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.totalDue).toBe(30);
      expect(mockListPrices).toHaveBeenCalledWith({
        lookup_keys: [plan],
      });
    },
  );

  it("allows organization owners to manage billing", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "owner" },
        },
      ],
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.totalDue).toBe(30);
    expect(mockListPrices).toHaveBeenCalledWith({
      lookup_keys: ["pro-monthly-plan"],
    });
  });

  it("scopes membership and billing lookup to the active organization", async () => {
    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));

    expect(response.status).toBe(200);
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_123",
      organizationId: "org_team",
      statuses: ["active"],
    });
    expect(mockGetOrganization).toHaveBeenCalledWith("org_team");
  });

  it("rejects billing changes when there is no active organization", async () => {
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_123",
      subscription: "free",
    } as never);

    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: "No active organization" });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockListCustomers).not.toHaveBeenCalled();
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("rejects billing changes without an active membership in the session organization", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [],
    } as never);

    const { POST } = await import("../route");
    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "No organization found" });
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_123",
      organizationId: "org_team",
      statuses: ["active"],
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockListCustomers).not.toHaveBeenCalled();
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("rejects non-owner, non-admin members from managing billing", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [
        {
          organizationId: "org_team",
          role: { slug: "member" },
        },
      ],
    } as never);

    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "pro-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "Only organization admins or owners can manage billing",
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockListPrices).not.toHaveBeenCalled();
  });

  it.each([
    ["below the minimum", 1, "Quantity must be a finite integer of at least 2"],
    ["non-integer", 2.5, "Quantity must be a finite integer of at least 2"],
    ["non-finite", Infinity, "Quantity must be a finite integer of at least 2"],
    ["non-number", "999", "Quantity must be a finite integer of at least 2"],
    ["too large", 1000, "Maximum 999 seats allowed"],
  ])("rejects %s team quantities", async (_name, quantity, error) => {
    const { POST } = await import("../route");

    const response = await POST(
      makeRequest({ plan: "team-monthly-plan", quantity }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error });
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockCreatePreview).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("defaults omitted team quantity to two seats", async () => {
    const { POST } = await import("../route");

    const response = await POST(makeRequest({ plan: "team-monthly-plan" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.quantity).toBe(2);
    expect(body.nextInvoiceAmount).toBe(60);
    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: "cus_team",
      status: "active",
      limit: 1,
    });
  });

  it("persists subscription-change attribution in metadata and analytics", async () => {
    arrangeProToUltraChange();

    const { POST } = await import("../route");

    const response = await POST(
      makeRequest({
        plan: "ultra-monthly-plan",
        confirm: true,
        checkoutAttemptId: "ca_paid_limit_123",
        source: "limit_pressure",
        surface: "pricing_dialog",
        reason: "monthly_exhausted",
        limitType: "monthly",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        metadata: expect.objectContaining({
          existing: "metadata",
          checkoutAttemptId: "ca_paid_limit_123",
          checkoutSource: "limit_pressure",
          checkoutSurface: "pricing_dialog",
          checkoutReason: "monthly_exhausted",
          checkoutLimitType: "monthly",
          checkoutType: "subscription_change",
        }),
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "checkout_started",
      expect.objectContaining({
        eventUuid: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        checkout_attempt_id: "ca_paid_limit_123",
        checkout_type: "subscription_change",
        source: "limit_pressure",
        surface: "pricing_dialog",
        reason: "monthly_exhausted",
        limit_type: "monthly",
        $insert_id: "checkout_started:ca_paid_limit_123",
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "checkout_succeeded",
      expect.objectContaining({
        checkout_attempt_id: "ca_paid_limit_123",
        checkout_type: "subscription_change",
        source: "limit_pressure",
        surface: "pricing_dialog",
        reason: "monthly_exhausted",
        limit_type: "monthly",
      }),
    );
  });

  describe("suspension read transport recovery", () => {
    const deployment = "https://fixture.convex.cloud";
    const secret = "synthetic-suspension-read-credential";
    const restoreGlobals: (() => void)[] = [];
    const originalFetch = globalThis.fetch;
    let actualHasActiveSuspension: typeof import("@/lib/suspensions").hasActiveSuspensionForUser;
    let createServiceConvexClient: typeof import("@/lib/db/service-client").createServiceConvexClient;
    let consoleSpies: { mockRestore(): void }[] = [];

    const connectionReset = (): never => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("read reset"), { code: "ECONNRESET" }),
      });
    };
    const convexResult = (value: unknown) => () =>
      new Response(JSON.stringify({ status: "success", value, logLines: [] }));
    const convexRejection = () =>
      new Response(
        JSON.stringify({
          status: "error",
          errorMessage: "Access denied",
          logLines: [],
        }),
      );

    /** Serve each suspension read in order through the actual service client. */
    function serveSuspensionReads(outcomes: (() => Response)[]) {
      const reads: { path: string; userId: unknown }[] = [];
      globalThis.fetch = jest.fn<typeof fetch>(async (_input, init) => {
        const { path, args } = JSON.parse(String(init?.body));
        reads.push({ path, userId: args[0].userId });
        const outcome = outcomes[reads.length - 1];
        if (!outcome) throw new Error("Unexpected extra suspension read");
        return outcome();
      });
      return reads;
    }

    function makeAbortableRequest(
      body: Record<string, unknown>,
      signal = new AbortController().signal,
    ) {
      return Object.assign(makeRequest(body), { signal });
    }

    beforeAll(async () => {
      // Loaded after jest.mock registration so the client uses the native SDK.
      ({ createServiceConvexClient } = await import("@/lib/db/service-client"));
      // Native SDK primitives, as in the service-query-recovery suite.
      const nativeAbort = transferableAbortController();
      const { Response: FetchResponse } = jest.requireActual<{
        Response: typeof Response;
      }>("next/dist/compiled/@edge-runtime/primitives/fetch");
      for (const [name, value] of Object.entries({
        Response: FetchResponse,
        AbortController: nativeAbort.constructor,
        AbortSignal: nativeAbort.signal.constructor,
        crypto: webcrypto,
      })) {
        const original = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { value, configurable: true });
        restoreGlobals.push(() => {
          if (original) Object.defineProperty(globalThis, name, original);
          else delete (globalThis as Record<string, unknown>)[name];
        });
      }
      // The helper reads its service key at load; never leak the fixture key.
      const priorKey = process.env.CONVEX_SERVICE_ROLE_KEY;
      try {
        process.env.CONVEX_SERVICE_ROLE_KEY = secret;
        actualHasActiveSuspension =
          jest.requireActual<typeof import("@/lib/suspensions")>(
            "@/lib/suspensions",
          ).hasActiveSuspensionForUser;
      } finally {
        if (priorKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
        else process.env.CONVEX_SERVICE_ROLE_KEY = priorKey;
      }
    });

    afterAll(() => {
      for (const restore of restoreGlobals.reverse()) restore();
    });

    beforeEach(() => {
      consoleSpies = (["error", "warn", "info"] as const).map((level) =>
        jest.spyOn(console, level).mockImplementation(() => {}),
      );
      mockHasActiveSuspensionForUser.mockImplementation(
        actualHasActiveSuspension,
      );
      mockGetConvexClient.mockImplementation((signal) =>
        createServiceConvexClient(deployment, signal && { signal }),
      );
      arrangeProToUltraChange();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      for (const spy of consoleSpies) spy.mockRestore();
      // Unconsumed one-time Stripe fixtures must not reach later tests.
      for (const mock of [
        mockListPrices,
        mockListSubscriptions,
        mockCreatePreview,
        mockUpdateSubscription,
      ])
        mock.mockReset();
    });

    it.each([false, true])(
      "recovers one reset suspension read and runs the confirm=%s handler once",
      async (confirm) => {
        const reads = serveSuspensionReads([
          connectionReset,
          convexResult(null),
        ]);
        const request = makeAbortableRequest({
          plan: "ultra-monthly-plan",
          confirm,
        });

        const { POST } = await import("../route");
        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject(
          confirm
            ? { success: true, subscriptionId: "sub_123" }
            : { totalDue: 80, proratedCredit: 20 },
        );
        expect(reads).toEqual([
          { path: "userSuspensions:getActiveByUser", userId: "user_123" },
          { path: "userSuspensions:getActiveByUser", userId: "user_123" },
        ]);
        expect(request.json).toHaveBeenCalledTimes(1);
        expect(mockGetUserIDAndPro).toHaveBeenCalledTimes(1);
        expect(mockCreatePreview).toHaveBeenCalledTimes(1);
        expect(mockUpdateSubscription).toHaveBeenCalledTimes(confirm ? 1 : 0);
      },
    );

    it("keeps an active suspension blocking the change after a recovered read", async () => {
      const reads = serveSuspensionReads([
        connectionReset,
        convexResult({
          status: "active",
          category: "policy",
          source: "manual",
          source_id: "fixture",
        }),
      ]);
      const request = makeAbortableRequest({
        plan: "ultra-monthly-plan",
        confirm: true,
      });

      const { POST } = await import("../route");
      const response = await POST(request);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: BILLING_ERRORS.accountSuspended,
      });
      expect(reads).toHaveLength(2);
      expect(mockGetUserIDAndPro).toHaveBeenCalledTimes(1);
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockListCustomers).not.toHaveBeenCalled();
      expect(mockUpdateSubscription).not.toHaveBeenCalled();
    });

    it.each([
      {
        failure: "a second reset exhausts the read",
        outcomes: () => [connectionReset, connectionReset],
        reads: 2,
      },
      {
        failure: "Convex rejects the recovered read",
        outcomes: () => [connectionReset, convexRejection],
        reads: 2,
      },
      {
        failure: "the request is aborted during the failed read",
        outcomes: (stop: AbortController) => [
          () => {
            stop.abort();
            return connectionReset();
          },
        ],
        reads: 1,
      },
    ])(
      "fails closed before billing when $failure",
      async ({ outcomes, reads: expectedReads }) => {
        const stop = new AbortController();
        const reads = serveSuspensionReads(outcomes(stop));
        const request = makeAbortableRequest(
          { plan: "ultra-monthly-plan", confirm: true },
          stop.signal,
        );

        const { POST } = await import("../route");
        const response = await POST(request);

        expect(response.status).toBe(500);
        expect(reads).toHaveLength(expectedReads);
        expect(request.json).toHaveBeenCalledTimes(1);
        expect(mockGetUserIDAndPro).toHaveBeenCalledTimes(1);
        expect(mockGetUser).not.toHaveBeenCalled();
        expect(mockUpdateSubscription).not.toHaveBeenCalled();
      },
    );
  });
});
