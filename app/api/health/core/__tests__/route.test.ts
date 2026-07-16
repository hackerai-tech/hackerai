import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { NextRequest } from "next/server";

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    headers: Headers;
    private body: unknown;

    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init);
    }

    async json() {
      return this.body;
    }
  },
}));

const mockFetch = jest.fn();
const originalHealthCheckToken = process.env.CORE_HEALTH_CHECK_TOKEN;
const originalWorkosApiKey = process.env.WORKOS_API_KEY;

function createRequest(token?: string): NextRequest {
  const headers = new Headers({
    "x-request-id": "request_123",
  });
  if (token) {
    headers.set("x-hackerai-health-token", token);
  }

  return {
    headers,
  } as NextRequest;
}

function fetchResponse({
  ok = true,
  status = 200,
}: {
  ok?: boolean;
  status?: number;
} = {}) {
  return {
    ok,
    status,
  };
}

describe("GET /api/health/core", () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.CORE_HEALTH_CHECK_TOKEN = "monitor-secret";
    process.env.WORKOS_API_KEY = "sk_test_workos";
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockResolvedValue(fetchResponse() as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();

    if (originalHealthCheckToken === undefined) {
      delete process.env.CORE_HEALTH_CHECK_TOKEN;
    } else {
      process.env.CORE_HEALTH_CHECK_TOKEN = originalHealthCheckToken;
    }

    if (originalWorkosApiKey === undefined) {
      delete process.env.WORKOS_API_KEY;
    } else {
      process.env.WORKOS_API_KEY = originalWorkosApiKey;
    }
  });

  it("returns 200 when WorkOS is available", async () => {
    const { GET } = await import("../route");

    const response = await GET(createRequest("monitor-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.workos.com/user_management/users?limit=1",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.anything(),
        headers: {
          accept: "application/json",
          authorization: "Bearer sk_test_workos",
        },
      }),
    );
    expect(body).toMatchObject({
      ok: true,
      service: "core",
      dependencies: {
        workos: {
          ok: true,
          status: 200,
          latencyMs: expect.any(Number),
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("monitor-secret");
    expect(JSON.stringify(body)).not.toContain("sk_test_workos");
  });

  it("rejects requests without the monitor token", async () => {
    const { GET } = await import("../route");

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 503 when required configuration is missing", async () => {
    delete process.env.CORE_HEALTH_CHECK_TOKEN;
    const { GET } = await import("../route");

    const response = await GET(createRequest("monitor-secret"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      error: "health_check_not_configured",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"missing_configuration"'),
    );
  });

  it("returns 503 when WorkOS returns an error status", async () => {
    mockFetch.mockResolvedValueOnce(
      fetchResponse({ ok: false, status: 504 }) as never,
    );
    const { GET } = await import("../route");

    const response = await GET(createRequest("monitor-secret"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      error: "workos_unavailable",
      dependencies: {
        workos: {
          ok: false,
          status: 504,
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"unexpected_status"'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"dependency_status":504'),
    );
  });

  it("returns 503 when the WorkOS request fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("request timeout") as never);
    const { GET } = await import("../route");

    const response = await GET(createRequest("monitor-secret"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      error: "workos_fetch_failed",
      dependencies: {
        workos: {
          ok: false,
          status: null,
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"fetch_failed"'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"error_message":"request timeout"'),
    );
  });
});
