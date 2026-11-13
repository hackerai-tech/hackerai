import { POST } from "../route";
import { PATCH } from "../members/[userId]/route";
import { requireAdminOrg } from "../../team-auth";
import { getConvexClient } from "@/lib/db/convex-client";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock("../../team-auth", () => ({ requireAdminOrg: jest.fn() }));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("../../../workos", () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: jest.fn(async () => ({
        data: [{ id: "membership" }],
      })),
    },
  },
}));

const mutation = jest.fn();
const request = (body: unknown) =>
  ({
    url: "https://hackerai.example/api/team/extra-usage",
    headers: new Headers({
      origin: "https://hackerai.example",
      "content-type": "application/json",
    }),
    json: async () => body,
  }) as never;
beforeEach(() => {
  (requireAdminOrg as jest.Mock).mockResolvedValue({
    ok: true,
    organizationId: "org-fixture",
    userId: "user-fixture",
  });
  (getConvexClient as jest.Mock).mockReturnValue({ mutation });
  mutation.mockReset();
});

it("rejects sibling-origin team changes before the admin check", async () => {
  const unsafe = request({ enabled: true }) as {
    headers: Headers;
  };
  unsafe.headers.set("origin", "https://evil.hackerai.example");
  unsafe.headers.set("content-type", "text/plain");

  expect((await POST(unsafe as never)).status).toBe(403);
  expect(
    (
      await PATCH(unsafe as never, {
        params: Promise.resolve({ userId: "user" }),
      })
    ).status,
  ).toBe(403);
  const { POST: purchase } = await import("../purchase/route");
  expect((await purchase(unsafe as never)).status).toBe(403);
  expect(requireAdminOrg).not.toHaveBeenCalled();
  expect(mutation).not.toHaveBeenCalled();
});

it.each([{ enabled: "true" }, { monthlyCapDollars: [] }, null, [true]])(
  "rejects malformed team settings before sending a credential: %j",
  async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
  },
);

it("preserves legitimate team settings", async () => {
  mutation.mockResolvedValue(null);
  const response = await POST(
    request({ enabled: true, monthlyCapDollars: null }),
  );
  expect(response.status).toBe(200);
  expect(mutation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ enabled: true, monthlyCapDollars: null }),
  );
});

it("does not return or log a raw credential-bearing Convex diagnostic", async () => {
  const secret = "synthetic-diagnostic-credential";
  mutation.mockRejectedValue(
    new Error(`ArgumentValidationError: Object: {serviceKey: "${secret}"}`),
  );
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await POST(request({ enabled: true }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  } finally {
    log.mockRestore();
  }
});

it("rejects malformed member settings before calling Convex", async () => {
  const response = await PATCH(request({ disabled: "yes" }), {
    params: Promise.resolve({ userId: "member-fixture" }),
  });
  expect(response.status).toBe(400);
  expect(mutation).not.toHaveBeenCalled();
});

it("keeps the team-admin authorization gate", async () => {
  (requireAdminOrg as jest.Mock).mockResolvedValue({
    ok: false,
    response: { status: 403 },
  });
  expect((await POST(request({ enabled: true }))).status).toBe(403);
  expect(mutation).not.toHaveBeenCalled();
});
