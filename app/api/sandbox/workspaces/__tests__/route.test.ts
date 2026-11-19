import type { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  chooseWorkspace,
  workspaceOptions,
} from "@/lib/ai/tools/utils/cloud-workspace-options";
import { ChatSDKError } from "@/lib/errors";
jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-options", () => ({
  chooseWorkspace: jest.fn(),
  workspaceOptions: jest.fn(),
  WorkspaceOptionsChanged: class extends Error {},
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
    url: "https://hackerai.test/api/sandbox/workspaces",
    headers: new Headers({ origin }),
    signal: new AbortController().signal,
    json: async () => body,
  }) as NextRequest;
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.VERCEL_ENV;
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "owner",
    subscription: "pro",
    emailVerified: true,
  });
  jest.mocked(workspaceOptions).mockResolvedValue({
    status: "selected",
    region: "eu-central-1",
    id: "eu-one",
  });
  jest.mocked(chooseWorkspace).mockResolvedValue({
    status: "selected",
    region: "eu-central-1",
    id: "eu-one",
  });
});
afterEach(() => jest.restoreAllMocks());
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
  expect((await POST(request({ workspaceId: "eu-one", token }))).status).toBe(
    403,
  );
  jest
    .mocked(assertUserCanMakeCostIncurringRequest)
    .mockRejectedValueOnce(new ChatSDKError("forbidden:api"));
  expect((await POST(request({ workspaceId: "eu-one", token }))).status).toBe(
    403,
  );
  expect(chooseWorkspace).not.toHaveBeenCalled();
});
it.each([
  { workspaceId: "eu-one", token, userId: "victim" },
  { workspaceId: "eu-one", token, sandboxId: "victim" },
  { workspaceId: "bad/id", token },
  { workspaceId: "eu-one" },
])("rejects foreign identity or invalid selection %j", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(chooseWorkspace).not.toHaveBeenCalled();
});
it("requires same origin and environment", async () => {
  expect(
    (
      await POST(
        request({ workspaceId: "eu-one", token }, "https://foreign.test"),
      )
    ).status,
  ).toBe(403);
  process.env.VERCEL_ENV = "preview";
  process.env.HACKERAI_ENVIRONMENT = "production";
  try {
    expect((await GET(request())).status).toBe(409);
    expect(workspaceOptions).not.toHaveBeenCalled();
  } finally {
    delete process.env.VERCEL_ENV;
    delete process.env.HACKERAI_ENVIRONMENT;
  }
  expect(chooseWorkspace).not.toHaveBeenCalled();
});
it("uses the authenticated owner and disables status caching", async () => {
  const result = await POST(request({ workspaceId: "eu-one", token }));
  expect(result.status).toBe(200);
  expect(chooseWorkspace).toHaveBeenCalledWith(
    "owner",
    "eu-one",
    token,
    expect.any(AbortSignal),
  );
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect((await GET(request())).headers.get("cache-control")).toBe("no-store");
});
it("does not repeat an uncertain write", async () => {
  jest.mocked(chooseWorkspace).mockRejectedValue(new Error("timeout"));
  expect((await POST(request({ workspaceId: "eu-one", token }))).status).toBe(
    409,
  );
  expect(chooseWorkspace).toHaveBeenCalledTimes(1);
});
