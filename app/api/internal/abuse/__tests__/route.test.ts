import type { NextRequest } from "next/server";
import { ConvexError } from "convex/values";
jest.mock("server-only", () => ({}));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init: any) => ({
      status: init.status,
      json: async () => body,
      headers: new Headers(init.headers),
    }),
  },
}));
const mockAuth = jest.fn(),
  mockMutation = jest.fn(),
  mockQuery = jest.fn();
jest.mock("@workos-inc/authkit-nextjs", () => ({
  authkit: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation, query: mockQuery }),
}));
jest.mock("@/lib/abuse/containment", () => ({
  executeAbuseContainment: jest.fn(),
  verifyContainmentTarget: jest.fn(),
  prepareAbuseResolution: jest.fn(),
  findAbuseSnapshot: jest.fn(),
}));
import { POST } from "../route";
import { encryptAbuseEvidence } from "@/lib/abuse/evidence";
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const original = { ...process.env };
function request(
  body: unknown = { action: "read", reference },
  origin = "https://preview.example.test",
) {
  return {
    nextUrl: new URL("https://preview.example.test/api/internal/abuse"),
    headers: new Headers({ origin, "content-type": "application/json" }),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        c.close();
      },
    }),
  } as NextRequest;
}
beforeEach(() => {
  process.env.ABUSE_OPERATOR_USER_IDS = "operator";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
  mockAuth.mockReset();
  mockMutation.mockReset();
  mockQuery.mockReset();
});
afterEach(() => {
  process.env = { ...original };
});
test.each([null, "customer", "ordinary-support"])(
  "rejects unauthenticated and non-allowlisted identity %s before evidence access",
  async (user) => {
    mockAuth.mockResolvedValue({
      session: user ? { user: { id: user } } : null,
    });
    expect((await POST(request())).status).toBe(403);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  },
);
test("does not let a caller supply an operator identity or use a foreign origin", async () => {
  mockAuth.mockResolvedValue({ session: { user: { id: "operator" } } });
  expect((await POST(request(undefined, "https://attacker.test"))).status).toBe(
    403,
  );
  expect(mockAuth).not.toHaveBeenCalled();
  expect(
    (await POST(request({ action: "read", reference, actor: "operator" })))
      .status,
  ).toBe(400);
  expect(mockMutation).not.toHaveBeenCalled();
});
test("authenticated reads use the audited mutation before returning decrypted evidence", async () => {
  mockAuth.mockResolvedValue({ session: { user: { id: "operator" } } });
  mockMutation.mockResolvedValue({
    case: {
      reference,
      ciphertext: encryptAbuseEvidence(reference, {
        description: "synthetic private allegation",
      }),
      digest: "private-digest",
      operationToken: "private-token",
    },
    events: [],
    isDone: true,
    continueCursor: "",
  });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(mockMutation.mock.calls[0][1]).toMatchObject({
    actor: "operator",
    reference,
  });
  const body = await response.json();
  expect(body.case.report.description).toBe("synthetic private allegation");
  expect(JSON.stringify(body)).not.toContain("private-token");
  expect(JSON.stringify(body)).not.toContain("private-digest");
  expect(response.headers.get("cache-control")).toContain("no-store");
});

test("reports only the known no-change rejection without forwarding backend evidence", async () => {
  mockAuth.mockResolvedValue({ session: { user: { id: "operator" } } });
  mockMutation.mockRejectedValue(
    new ConvexError({
      code: "ABUSE_ACTIVE_ROOT_CHANGED",
      message: "private backend evidence",
    }),
  );
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "ABUSE_ACTIVE_ROOT_CHANGED" });

  mockMutation.mockRejectedValue(
    new ConvexError({
      code: "UNKNOWN_FAILURE",
      message: "private backend evidence",
    }),
  );
  const unknown = await POST(request());
  expect(await unknown.json()).toEqual({
    error: expect.stringContaining("not confirmed"),
  });
});
