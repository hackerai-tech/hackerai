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
