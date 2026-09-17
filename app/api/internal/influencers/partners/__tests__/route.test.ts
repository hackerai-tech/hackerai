const mockQuery = jest.fn();
const mockMutation = jest.fn();
const mockAccount = jest.fn();
const mockBalance = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
  getConvexUrl: () => "https://verified.convex.cloud",
}));
jest.mock("@/app/api/stripe", () => ({
  stripe: {
    accounts: { retrieveCurrent: mockAccount },
    balance: { retrieve: mockBalance },
  },
}));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, options: ResponseInit) => ({ body, ...options }),
  },
}));
import { createFreeQuotaSubjectWithSecret } from "@/lib/auth/free-quota-subject-core";
const { POST } = require("../route") as typeof import("../route");

const payload = {
  targetUrl: "https://verified.convex.cloud",
  stripeAccountId: "acct_verified",
  live: true,
  code: "hackerai",
  name: "HackerAI",
  email: "owner@example.com",
};
function request(body: unknown = payload, token = "operator-secret") {
  const read = jest
    .fn()
    .mockResolvedValueOnce({
      done: false,
      value: Buffer.from(
        typeof body === "string" ? body : JSON.stringify(body),
      ),
    })
    .mockResolvedValueOnce({ done: true });
  return {
    headers: new Headers({ authorization: `Bearer ${token}` }),
    body: {
      getReader: () => ({ read, cancel: jest.fn(), releaseLock: jest.fn() }),
    },
  } as unknown as Request;
}
const partner = () => ({
  name: payload.name,
  contact_email: payload.email,
  active: true,
  owner_identity: createFreeQuotaSubjectWithSecret(
    payload.email,
    "server-only-secret",
  ),
  monthly_bps: 1500,
  annual_bps: 1000,
});
const originalEnv = { ...process.env };
beforeEach(() => {
  jest.resetAllMocks();
  process.env.CONVEX_SERVICE_ROLE_KEY = "operator-secret";
  process.env.ACCOUNT_IDENTITY_HMAC_SECRET = "server-only-secret";
  process.env.NEXT_PUBLIC_BASE_URL = "https://hackerai.co";
  mockAccount.mockResolvedValue({ id: "acct_verified" });
  mockBalance.mockResolvedValue({ livemode: true });
  mockQuery.mockResolvedValue(null);
  mockMutation.mockResolvedValue("partner-id");
});
afterAll(() => {
  process.env = originalEnv;
});

it.each(["", "wrong-secret"])(
  "rejects unauthorized callers before reading data (%s)",
  async (token) => {
    const req = request(payload, token);
    const readBody = jest.spyOn(req.body!, "getReader");
    expect((await POST(req)).status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(mockAccount).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  },
);
it("fails closed when service authentication is not configured", async () => {
  delete process.env.CONVEX_SERVICE_ROLE_KEY;
  expect((await POST(request())).status).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});
it.each([
  ["{bad", 400],
  ["x".repeat(4097), 413],
  [{ ...payload, code: "../bad" }, 400],
  [{ ...payload, monthlyBps: 10001 }, 400],
  [{ ...payload, ownerIdentity: "forged" }, 400],
  [{ ...payload, targetUrl: "https://other.convex.cloud" }, 409],
])(
  "rejects malformed or wrong-target requests before provider access",
  async (body, status) => {
    expect((await POST(request(body))).status).toBe(status);
    expect(mockAccount).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  },
);
it.each(["account", "mode"])(
  "rejects a mismatched Stripe %s",
  async (mismatch) => {
    if (mismatch === "account")
      mockAccount.mockResolvedValue({ id: "acct_other" });
    else mockBalance.mockResolvedValue({ livemode: false });
    expect((await POST(request())).status).toBe(409);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  },
);
it("fails closed without the web runtime signing secret", async () => {
  delete process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
  expect((await POST(request())).status).toBe(503);
  expect(mockMutation).not.toHaveBeenCalled();
});
it("creates the canonical owner identity only on the server and returns a safe link", async () => {
  const response = await POST(
    request({ ...payload, email: "OWNER@example.com", name: " HackerAI " }),
  );
  expect(response).toMatchObject({
    status: 201,
    body: {
      code: "hackerai",
      link: "https://hackerai.co/r/hackerai",
      monthlyBps: 1500,
      annualBps: 1000,
    },
    headers: { "Cache-Control": "private, no-store" },
  });
  expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
    serviceKey: "operator-secret",
    code: payload.code,
    name: payload.name,
    contactEmail: payload.email,
    ownerIdentity: partner().owner_identity,
    monthlyBps: 1500,
    annualBps: 1000,
  });
  const serialized = JSON.stringify(response);
  for (const privateValue of [
    payload.email,
    partner().owner_identity!,
    "server-only-secret",
    "operator-secret",
  ])
    expect(serialized).not.toContain(privateValue);
});
it("reuses an identical active partner without another mutation", async () => {
  mockQuery.mockResolvedValue(partner());
  expect((await POST(request())).status).toBe(200);
  expect(mockMutation).not.toHaveBeenCalled();
});
it.each([
  { active: false },
  { name: "Different" },
  { contact_email: "other@example.com" },
  { owner_identity: "different" },
  { monthly_bps: 2000 },
  { annual_bps: 1500 },
])(
  "refuses to overwrite conflicting or inactive partner %j",
  async (change) => {
    mockQuery.mockResolvedValue({ ...partner(), ...change });
    expect((await POST(request())).status).toBe(409);
    expect(mockMutation).not.toHaveBeenCalled();
  },
);
it("recovers a committed mutation after a lost response", async () => {
  mockQuery.mockResolvedValueOnce(null).mockResolvedValueOnce(partner());
  mockMutation.mockRejectedValue(new Error("lost response"));
  expect((await POST(request())).status).toBe(200);
  expect(mockMutation).toHaveBeenCalledTimes(1);
});
it("checks ownership after a concurrent creation", async () => {
  mockQuery
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...partner(), owner_identity: "other" });
  mockMutation.mockRejectedValue(new Error("duplicate"));
  expect((await POST(request())).status).toBe(409);
});
it("returns a retryable error without exposing provider request data", async () => {
  mockMutation.mockRejectedValue(new Error("private provider request"));
  expect(await POST(request())).toMatchObject({ status: 503 });
  mockAccount.mockRejectedValue(new Error("private provider request"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(response)).not.toContain("private provider request");
});
