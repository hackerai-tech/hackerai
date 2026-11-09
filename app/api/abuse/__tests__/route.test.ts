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
) {
  return {
    nextUrl: new URL("https://hackerai.co/api/abuse"),
    headers: new Headers({ origin, "content-type": "application/json" }),
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
  process.env.ABUSE_OPERATOR_USER_IDS = "operator";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
  mockMutation.mockReset();
});
afterEach(() => {
  process.env = { ...originalEnv };
});
test("anonymous intake returns a receipt only after encrypted storage confirms it", async () => {
  let release: (value: unknown) => void = () => {};
  mockMutation.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  let completed = false;
  const pending = POST(request()).then((result) => {
    completed = true;
    return result;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(completed).toBe(false);
  const args = mockMutation.mock.calls[0][1];
  expect(JSON.stringify(args)).not.toContain(report.email);
  expect(JSON.stringify(args)).not.toContain(report.evidence);
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
