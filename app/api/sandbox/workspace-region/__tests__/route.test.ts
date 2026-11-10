import type { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  selectWorkspaceRegion,
  workspaceRegionView,
} from "@/lib/ai/tools/utils/cloud-workspace-selection";
import { ChatSDKError } from "@/lib/errors";
jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-selection", () => ({
  selectWorkspaceRegion: jest.fn(),
  workspaceRegionView: jest.fn(),
}));
const token = "a".repeat(64);
jest.mock("next/server", () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(init?.headers),
    }),
  },
}));
Object.defineProperty(globalThis, "Response", {
  configurable: true,
  value: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
});
const request = (body?: unknown, origin = "https://hackerai.test") =>
  ({
    url: "https://hackerai.test/api/sandbox/workspace-region",
    headers: new Headers({ origin }),
    json: async () => body,
  }) as NextRequest;
beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.VERCEL_ENV;
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "owner",
    subscription: "pro",
    emailVerified: true,
  });
  jest
    .mocked(workspaceRegionView)
    .mockResolvedValue({ status: "selected", region: "eu-central-1" });
  jest
    .mocked(selectWorkspaceRegion)
    .mockResolvedValue({ status: "selected", region: "eu-central-1" });
});
it("authenticates status reads and rejects unpaid or suspended writes", async () => {
  jest
    .mocked(getUserIDAndPro)
    .mockRejectedValueOnce(new ChatSDKError("unauthorized:auth"));
  expect((await GET(request())).status).toBe(401);
  jest.mocked(getUserIDAndPro).mockResolvedValueOnce({
    userId: "owner",
    subscription: "free",
    emailVerified: true,
  });
  expect((await POST(request({ region: "eu-central-1", token }))).status).toBe(
    403,
  );
  jest
    .mocked(assertUserCanMakeCostIncurringRequest)
    .mockRejectedValueOnce(new ChatSDKError("forbidden:api"));
  expect((await POST(request({ region: "eu-central-1", token }))).status).toBe(
    403,
  );
  expect(selectWorkspaceRegion).not.toHaveBeenCalled();
});
it.each([
  { region: "eu-central-1", token, userId: "victim" },
  { region: "eu-central-1", token, sandboxId: "victim" },
  { region: "other", token },
  { region: "eu-central-1" },
])("rejects foreign identity or invalid selection %j", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(selectWorkspaceRegion).not.toHaveBeenCalled();
});
it("requires same origin and environment", async () => {
  expect(
    (
      await POST(
        request({ region: "eu-central-1", token }, "https://foreign.test"),
      )
    ).status,
  ).toBe(403);
  process.env.VERCEL_ENV = "preview";
  process.env.HACKERAI_ENVIRONMENT = "production";
  try {
    expect((await GET(request())).status).toBe(409);
    expect(workspaceRegionView).not.toHaveBeenCalled();
  } finally {
    delete process.env.VERCEL_ENV;
    delete process.env.HACKERAI_ENVIRONMENT;
  }
  expect(selectWorkspaceRegion).not.toHaveBeenCalled();
});
it("uses the authenticated owner and disables status caching", async () => {
  const result = await POST(request({ region: "eu-central-1", token }));
  expect(result.status).toBe(200);
  expect(selectWorkspaceRegion).toHaveBeenCalledWith(
    "owner",
    "eu-central-1",
    token,
  );
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect((await GET(request())).headers.get("cache-control")).toBe("no-store");
});
it("does not repeat an uncertain write", async () => {
  jest.mocked(selectWorkspaceRegion).mockRejectedValue(new Error("timeout"));
  expect((await POST(request({ region: "eu-central-1", token }))).status).toBe(
    409,
  );
  expect(selectWorkspaceRegion).toHaveBeenCalledTimes(1);
});
