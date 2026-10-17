jest.mock("@e2b/code-interpreter", () => ({ Sandbox: {} }));
import type { NextRequest } from "next/server";
import { GET, PUT } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  saveNetworkSettings,
  readNetworkSettings,
} from "@/lib/cloud-network/service";
import { ChatSDKError } from "@/lib/errors";
jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/cloud-network/service", () => ({
  ...jest.requireActual("@/lib/cloud-network/service"),
  readNetworkSettings: jest.fn(),
  saveNetworkSettings: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
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
const request = (body: unknown) => ({ json: async () => body }) as NextRequest;
beforeEach(() => {
  jest.clearAllMocks();
  (getUserIDAndPro as jest.Mock).mockResolvedValue({
    userId: "authenticated-owner",
    subscription: "pro",
  });
});
it("derives ownership from the session and validates unsupported destinations before provider calls", async () => {
  (saveNetworkSettings as jest.Mock).mockResolvedValue({ status: "ready" });
  expect(
    (
      await PUT(
        request({
          userId: "victim",
          expectedRevision: 0,
          policy: { mode: "offline", allow: [] },
        }),
      )
    ).status,
  ).toBe(200);
  expect(saveNetworkSettings).toHaveBeenCalledWith(
    "authenticated-owner",
    { mode: "offline", allow: [] },
    0,
    undefined,
  );
  (saveNetworkSettings as jest.Mock).mockClear();
  expect(
    (
      await PUT(
        request({
          expectedRevision: 0,
          policy: { mode: "restricted", allow: ["https://example.test/path"] },
        }),
      )
    ).status,
  ).toBe(400);
  expect(saveNetworkSettings).not.toHaveBeenCalled();
});
it("rejects unauthenticated and ineligible requests", async () => {
  (getUserIDAndPro as jest.Mock).mockRejectedValueOnce(
    new ChatSDKError("unauthorized:auth"),
  );
  expect((await GET(request({}))).status).toBe(401);
  (getUserIDAndPro as jest.Mock).mockResolvedValueOnce({
    userId: "free",
    subscription: "free",
  });
  expect((await PUT(request({}))).status).toBe(403);
  expect(readNetworkSettings).not.toHaveBeenCalled();
  expect(saveNetworkSettings).not.toHaveBeenCalled();
});

it("accepts proxy credentials for the authenticated owner without returning or tracking them", async () => {
  const proxy = {
    address: "proxy.example.test:1080",
    credentials: { username: "synthetic-user", password: "synthetic-secret" },
  };
  const settings = {
    policy: { mode: "offline", allow: [] },
    revision: 1,
    status: "ready",
    proxy: { address: proxy.address, authenticated: true, revision: "opaque" },
  };
  jest.mocked(saveNetworkSettings).mockResolvedValueOnce(settings as any);
  const response = await PUT(
    request({
      policy: settings.policy,
      expectedRevision: 0,
      proxy,
      userId: "other",
    }),
  );
  expect(response.status).toBe(200);
  expect(saveNetworkSettings).toHaveBeenCalledWith(
    "authenticated-owner",
    settings.policy,
    0,
    proxy,
  );
  expect(JSON.stringify(await response.json())).not.toContain(
    "synthetic-secret",
  );
  const events = require("@/lib/posthog/server").phLogger.event;
  expect(events).toHaveBeenCalledWith("cloud_network_settings_saved", {
    userId: "authenticated-owner",
    mode: "offline",
    destination_count: 0,
    proxy_enabled: true,
  });
  for (const privateValue of [
    "synthetic-secret",
    "synthetic-user",
    proxy.address,
  ]) {
    expect(JSON.stringify(events.mock.calls)).not.toContain(privateValue);
  }
});
it("rejects embedded credentials and oversize credentials before saving", async () => {
  for (const proxy of [
    { address: "user:secret@proxy.test:1080" },
    {
      address: "proxy.test:1080",
      credentials: { username: "u", password: "x".repeat(256) },
    },
  ]) {
    const response = await PUT(
      request({
        policy: { mode: "offline", allow: [] },
        expectedRevision: 0,
        proxy,
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("user:secret");
  }
  expect(saveNetworkSettings).not.toHaveBeenCalled();
});
