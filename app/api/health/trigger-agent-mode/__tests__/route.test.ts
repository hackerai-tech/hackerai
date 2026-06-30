import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    headers?: HeadersInit;
    private body: unknown;

    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers;
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

const triggerFeed = (
  statuses: Partial<Record<"8931867" | "8931869" | "8649602", string>> = {},
) => ({
  included: [
    {
      id: "8931867",
      type: "status_page_resource",
      attributes: {
        public_name: "Task execution",
        status: statuses["8931867"] ?? "operational",
      },
    },
    {
      id: "8931869",
      type: "status_page_resource",
      attributes: {
        public_name: "Task execution",
        status: statuses["8931869"] ?? "operational",
      },
    },
    {
      id: "8649602",
      type: "status_page_resource",
      attributes: {
        public_name: "Realtime",
        status: statuses["8649602"] ?? "operational",
      },
    },
    {
      id: "8416312",
      type: "status_page_resource",
      attributes: {
        public_name: "Dashboard",
        status: "degraded",
      },
    },
    {
      id: "8416313",
      type: "status_page_resource",
      attributes: {
        public_name: "API",
        status: "degraded",
      },
    },
  ],
});

const fetchResponse = ({
  ok = true,
  status = 200,
  body = triggerFeed(),
}: {
  ok?: boolean;
  status?: number;
  body?: unknown;
} = {}) => ({
  ok,
  status,
  json: async () => body,
});

describe("GET /api/health/trigger-agent-mode", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockResolvedValue(fetchResponse() as never);
  });

  it("returns 200 when the Agent-relevant Trigger resources are operational", async () => {
    const { GET } = await import("../route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://status.trigger.dev/index.json",
      expect.objectContaining({
        cache: "no-store",
        headers: { accept: "application/json" },
      }),
    );
    expect(body).toMatchObject({
      ok: true,
      source: "https://status.trigger.dev/index.json",
      resources: [
        {
          id: "8931867",
          name: "US East task execution",
          status: "operational",
          operational: true,
        },
        {
          id: "8931869",
          name: "EU Central task execution",
          status: "operational",
          operational: true,
        },
        {
          id: "8649602",
          name: "Global realtime",
          status: "operational",
          operational: true,
        },
      ],
    });
  });

  it("ignores unrelated degraded API and Dashboard resources", async () => {
    const { GET } = await import("../route");
    mockFetch.mockResolvedValueOnce(
      fetchResponse({
        body: triggerFeed(),
      }) as never,
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("returns 503 when a required Trigger resource is degraded", async () => {
    const { GET } = await import("../route");
    mockFetch.mockResolvedValueOnce(
      fetchResponse({
        body: triggerFeed({ "8931867": "degraded" }),
      }) as never,
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      resources: expect.arrayContaining([
        {
          id: "8931867",
          name: "US East task execution",
          status: "degraded",
          operational: false,
        },
      ]),
    });
  });

  it("returns 503 when a required Trigger resource is missing", async () => {
    const { GET } = await import("../route");
    mockFetch.mockResolvedValueOnce(
      fetchResponse({
        body: {
          included: triggerFeed().included.filter(
            (resource) => resource.id !== "8931869",
          ),
        },
      }) as never,
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      resources: expect.arrayContaining([
        {
          id: "8931869",
          name: "EU Central task execution",
          status: "missing",
          operational: false,
        },
      ]),
    });
  });

  it("returns 503 when Trigger's status feed is unavailable", async () => {
    const { GET } = await import("../route");
    mockFetch.mockResolvedValueOnce(
      fetchResponse({ ok: false, status: 502 }) as never,
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      error: "trigger_status_unavailable",
      sourceStatus: 502,
    });
  });

  it("returns 503 when Trigger's status feed cannot be fetched", async () => {
    const { GET } = await import("../route");
    mockFetch.mockRejectedValueOnce(new Error("network failure") as never);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      error: "trigger_status_fetch_failed",
      message: "network failure",
    });
  });
});
