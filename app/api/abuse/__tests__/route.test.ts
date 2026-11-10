import type { NextRequest } from "next/server";
jest.mock("server-only", () => ({}));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init: any) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));
const mockMutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));
jest.mock("@vercel/functions", () => ({ ipAddress: () => "198.51.100.9" }));
import { POST } from "../route";
import { decryptAbuseEvidence } from "@/lib/abuse/evidence";
import { ABUSE_REQUEST_MAX_BYTES } from "@/lib/abuse/report";
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const mockVerify = jest.fn();
const report = {
  submissionId: "123e4567-e89b-42d3-a456-426614174000",
  kind: "abuse",
  email: "reporter@example.test",
  target: "example.test",
  description: "SYNTHETIC_PRIVATE_REPORT: sample observation only.",
  evidence: "SYNTHETIC_PRIVATE_LOG",
};
function request(
  body = JSON.stringify(report),
  origin = "https://hackerai.co",
  token = "synthetic-challenge",
) {
  return {
    nextUrl: new URL("https://hackerai.co/api/abuse"),
    headers: new Headers({
      origin,
      "content-type": "application/json",
      "x-turnstile-token": token,
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  } as NextRequest;
}
beforeEach(() => {
  process.env.ABUSE_INTAKE_ENABLED = "true";
  delete process.env.ABUSE_OPERATOR_USER_IDS;
  process.env.ABUSE_TURNSTILE_SITE_KEY = "synthetic-site-key-for-testing";
  process.env.ABUSE_TURNSTILE_SECRET_KEY = "synthetic-secret-key-for-testing";
  process.env.ABUSE_TURNSTILE_HOSTNAMES = "hackerai.co";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
  mockMutation.mockReset();
  global.fetch = mockVerify;
  mockVerify.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      hostname: "hackerai.co",
      action: "abuse_report",
    }),
  });
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});
test("anonymous intake returns a receipt only after encrypted queue storage confirms it", async () => {
  let release: (value: unknown) => void = () => {};
  let reachedStorage: () => void = () => {};
  const storageStarted = new Promise<void>((resolve) => {
    reachedStorage = resolve;
  });
  mockMutation.mockImplementation(() => {
    reachedStorage();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  let completed = false;
  const pending = POST(request()).then((result) => {
    completed = true;
    return result;
  });
  await storageStarted;
  expect(completed).toBe(false);
  const args = mockMutation.mock.calls[0][1];
  expect(JSON.stringify(args)).not.toContain(report.email);
  expect(JSON.stringify(args)).not.toContain(report.evidence);
  expect(JSON.stringify(args)).not.toContain("synthetic-challenge");
  expect(JSON.parse(mockVerify.mock.calls[0][1].body)).toEqual({
    secret: process.env.ABUSE_TURNSTILE_SECRET_KEY,
    response: "synthetic-challenge",
  });
  expect(decryptAbuseEvidence(args.reference, args.ciphertext)).toMatchObject(
    report,
  );
  release({ outcome: "received", reference: args.reference });
  const response = await pending;
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    received: true,
    reference: args.reference,
  });
  expect(response.headers.get("cache-control")).toContain("no-store");
});

test.each(["", "x".repeat(2049)])(
  "rejects absent or oversized challenge before provider and storage",
  async (token) => {
    expect((await POST(request(undefined, undefined, token))).status).toBe(403);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  },
);

test.each([
  { success: false, "error-codes": ["invalid-input-response"] },
  { success: false, "error-codes": ["timeout-or-duplicate"] },
  { success: true, hostname: "other.test", action: "abuse_report" },
  { success: true, hostname: "hackerai.co", action: "login" },
  { success: true, hostname: "hackerai.co" },
])(
  "requires a fresh verification bound to the report hostname and action: %j",
  async (result) => {
    mockVerify.mockResolvedValue({ ok: true, json: async () => result });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "verification_failed",
    });
    expect(mockMutation).not.toHaveBeenCalled();
  },
);

test.each(["missing", "dummy", "foreign-host", "malformed-host"])(
  "fails closed for %s configuration",
  async (configuration) => {
    if (configuration === "missing")
      delete process.env.ABUSE_TURNSTILE_SECRET_KEY;
    if (configuration === "dummy")
      process.env.ABUSE_TURNSTILE_SECRET_KEY =
        "1x0000000000000000000000000000000AA";
    if (configuration === "foreign-host")
      process.env.ABUSE_TURNSTILE_HOSTNAMES = "other.test";
    if (configuration === "malformed-host")
      process.env.ABUSE_TURNSTILE_HOSTNAMES = `0${"-".repeat(248)}!`;
    const response = await POST(request());
    expect(response.status).toBe(configuration === "foreign-host" ? 403 : 503);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  },
);

test.each(["network", "http", "json", "provider"])(
  "sanitizes %s verification failure and never persists",
  async (failure) => {
    const privateError = new Error(report.description);
    if (failure === "network") mockVerify.mockRejectedValue(privateError);
    if (failure === "http") mockVerify.mockResolvedValue({ ok: false });
    if (failure === "json")
      mockVerify.mockResolvedValue({
        ok: true,
        json: async () => {
          throw privateError;
        },
      });
    if (failure === "provider")
      mockVerify.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          "error-codes": ["internal-error"],
        }),
      });
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "verification_unavailable",
    });
    expect(JSON.stringify(await response.json())).not.toContain(
      report.description,
    );
    expect(mockMutation).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  },
);

test("renewing a consumed challenge preserves the durable submission fingerprint after storage response loss", async () => {
  mockMutation.mockRejectedValueOnce(new Error("response lost"));
  mockMutation.mockImplementationOnce(async (_ref, args) => ({
    outcome: "received",
    reference: args.reference,
  }));
  expect((await POST(request())).status).toBe(503);
  expect(
    (await POST(request(undefined, undefined, "new-challenge"))).status,
  ).toBe(201);
  const first = mockMutation.mock.calls[0][1],
    retry = mockMutation.mock.calls[1][1];
  expect(retry.reference).toBe(first.reference);
  expect(retry.digests).toEqual(first.digests);
  expect(decryptAbuseEvidence(retry.reference, retry.ciphertext)).toEqual(
    decryptAbuseEvidence(first.reference, first.ciphertext),
  );
  expect(
    mockVerify.mock.calls.map(([, init]) => JSON.parse(init.body).response),
  ).toEqual(["synthetic-challenge", "new-challenge"]);
});
test("provider failures emit neither a success receipt nor private error/log details", async () => {
  mockMutation.mockRejectedValue(new Error(report.description));
  const logs = jest.spyOn(console, "error").mockImplementation(() => {});
  const response = await POST(request());
  expect(response.status).toBe(503);
  const output = await response.json();
  expect(output.received).toBeUndefined();
  expect(JSON.stringify(output)).not.toContain(report.description);
  expect(logs).not.toHaveBeenCalled();
  logs.mockRestore();
});
test("rejects foreign origins, malformed private bodies, and oversized streams without persisting", async () => {
  expect((await POST(request(undefined, "https://other.test"))).status).toBe(
    403,
  );
  const malformed = await POST(
    request('{"secret":"SYNTHETIC_PRIVATE_LOG",oops'),
  );
  expect(malformed.status).toBe(400);
  expect(JSON.stringify(await malformed.json())).not.toContain(report.evidence);
  expect(
    (await POST(request("x".repeat(ABUSE_REQUEST_MAX_BYTES + 1)))).status,
  ).toBe(413);
  expect(mockMutation).not.toHaveBeenCalled();
});
test("accepts maximum-length non-Latin fields without a contradictory size error", async () => {
  const multilingual = {
    ...report,
    description: "報".repeat(6000),
    evidence: "證".repeat(6000),
    target: "例".repeat(500),
  };
  mockMutation.mockImplementation(async (_ref, args) => ({
    outcome: "received",
    reference: args.reference,
  }));
  const response = await POST(request(JSON.stringify(multilingual)));
  expect(response.status).toBe(201);
  const args = mockMutation.mock.calls[0][1];
  expect(decryptAbuseEvidence(args.reference, args.ciphertext)).toMatchObject(
    multilingual,
  );
  expect(args.ciphertext.length).toBeLessThanOrEqual(128 * 1024);
});
test("does not expose provider errors or receipt fields for validation and rate-limit failures", async () => {
  const invalid = await POST(
    request(JSON.stringify({ ...report, email: "invalid" })),
  );
  expect(invalid.status).toBe(400);
  expect(mockMutation).not.toHaveBeenCalled();
  mockMutation.mockResolvedValue({ outcome: "rate_limited" });
  const limited = await POST(request());
  expect(limited.status).toBe(429);
  expect((await limited.json()).received).toBeUndefined();
});

test("expired delivery receipts return a finite resubmission response without a new success", async () => {
  mockMutation.mockResolvedValue({ outcome: "expired" });
  const response = await POST(request());
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({ code: "report_expired" });
  expect((await response.json()).reference).toBeUndefined();
});
