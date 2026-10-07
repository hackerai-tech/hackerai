import { GET } from "../route";
import { GET as reportsGET } from "../../trigger-reports/route";
import { GET as collectGET } from "../../../cron/trigger-health/route";
import {
  readTriggerHealth,
  refreshTriggerHealth,
} from "@/lib/health/trigger-health";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));
jest.mock("@/lib/health/trigger-health", () => ({
  readTriggerHealth: jest.fn(),
  refreshTriggerHealth: jest.fn(),
}));
function requestWithHeaders(_url: string, init?: RequestInit): Request {
  return { headers: new Headers(init?.headers) } as Request;
}
const read = jest.mocked(readTriggerHealth);
const refresh = jest.mocked(refreshTriggerHealth);
const originalSecret = process.env.CRON_SECRET;
afterEach(() => {
  jest.resetAllMocks();
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

it("keeps successful execution up when reporting times out", async () => {
  read.mockResolvedValue({
    probe: { status: "healthy", checkedAt: "2026-09-14T12:00:00Z" },
    report: { status: "unknown", error: "trigger_report_timeout" },
  });
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    ok: true,
    source: "trigger_probe",
  });
  expect((await reportsGET()).status).toBe(503);
  expect(refresh).not.toHaveBeenCalled();
});

it.each(["failing", "unknown"] as const)(
  "does not hide %s execution behind a healthy report",
  async (status) => {
    read.mockResolvedValue({
      probe: { status, checkedAt: "2026-09-14T12:00:00Z" },
      report: { status: "healthy" },
    });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('"ok":true');
  },
);

it.each([undefined, "", "wrong", "Bearer wrong", "Bearer undefined"])(
  "rejects unauthorized collection (%s)",
  async (authorization) => {
    process.env.CRON_SECRET = "test-cron-secret";
    const response = await collectGET(
      requestWithHeaders("http://localhost/api/cron/trigger-health", {
        headers: authorization ? { authorization } : {},
      }),
    );
    expect(response.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  },
);

it("fails closed without a configured cron secret", async () => {
  delete process.env.CRON_SECRET;
  expect(
    (
      await collectGET(
        requestWithHeaders("http://localhost", {
          headers: { authorization: "Bearer undefined" },
        }),
      )
    ).status,
  ).toBe(401);
  expect(refresh).not.toHaveBeenCalled();
});

it("runs authorized collection and propagates storage failure", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const request = requestWithHeaders("http://localhost", {
    headers: { authorization: "Bearer test-cron-secret" },
  });
  refresh.mockResolvedValueOnce({
    ok: false,
    error: "health_store_unavailable",
  });
  expect((await collectGET(request)).status).toBe(503);
  refresh.mockResolvedValueOnce({ ok: true });
  expect((await collectGET(request)).status).toBe(200);
});
