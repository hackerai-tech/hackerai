import type { NextRequest } from "next/server";
import { accessLocalWorkspaceFiles } from "@/lib/sandbox/local-workspace-files";
import { GET, POST } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById } from "@/lib/db/actions";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import { accessCloudWorkspaceFiles } from "@/lib/sandbox/cloud-workspace-files";
import {
  assertUserCanAccessChatHistory,
  assertUserCanMakeCostIncurringRequest,
} from "@/lib/suspensions";
import { ChatSDKError } from "@/lib/errors";
import { createRedisClient } from "@/lib/rate-limit/redis";

jest.mock("@/lib/sandbox/local-workspace-files", () => ({
  accessLocalWorkspaceFiles: jest.fn(),
}));
jest.mock("@/lib/chat/project-context", () => ({
  resolveProjectExecutionContext: jest.fn().mockResolvedValue({}),
}));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/db/actions", () => ({ getChatById: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(),
  phLogger: { event: jest.fn() },
}));
jest.mock("@/lib/sandbox/cloud-workspace-files", () => ({
  accessCloudWorkspaceFiles: jest.fn(),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
  assertUserCanAccessChatHistory: jest.fn(),
}));

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));
const makeRequest = (url: string, body?: unknown) =>
  ({
    nextUrl: new URL(url),
    headers: new Headers({ origin: "https://preview.example" }),
    text: async () => JSON.stringify(body),
  }) as unknown as NextRequest;
const request = (values = {}) =>
  makeRequest("https://preview.example/api/workspace-files", {
    chatId: "chat",
    action: "list",
    ...values,
  });
beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(
      require("@/lib/chat/project-context").resolveProjectExecutionContext,
    )
    .mockResolvedValue({});
  jest
    .mocked(accessLocalWorkspaceFiles)
    .mockResolvedValue({ state: "disconnected", environmentLabel: "Local" });
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "owner",
    subscription: "pro",
    emailVerified: true,
  });
  jest
    .mocked(getChatById)
    .mockResolvedValue({ user_id: "owner", sandbox_type: "e2b" } as any);
  jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(true);
  jest
    .mocked(accessCloudWorkspaceFiles)
    .mockResolvedValue({ state: "missing" });
});

it("keeps capability discovery separate from live sandbox access", async () => {
  const response = await GET(
    makeRequest("https://preview.example/api/workspace-files?chatId=chat"),
  );
  expect(await response.json()).toEqual({ enabled: true });
  expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
});
it("preserves history-access denials without exposing internal details", async () => {
  jest
    .mocked(assertUserCanAccessChatHistory)
    .mockRejectedValue(
      new ChatSDKError("forbidden:chat", "private denial detail"),
    );
  const response = await GET(
    makeRequest("https://preview.example/api/workspace-files?chatId=chat"),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.json()).toEqual({ error: "forbidden" });
  expect(getChatById).not.toHaveBeenCalled();
  expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
});
it("rejects another user's chat and disabled flags before sandbox access", async () => {
  jest.mocked(getChatById).mockResolvedValue({ user_id: "other" } as any);
  expect((await POST(request())).status).toBe(404);
  jest.mocked(getChatById).mockResolvedValue({ user_id: "owner" } as any);
  jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(null);
  expect((await POST(request())).status).toBe(404);
  expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
});
it("preserves subscription and suspension gates", async () => {
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "owner",
    subscription: "free",
    emailVerified: true,
  });
  expect((await POST(request())).status).toBe(403);
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "owner",
    subscription: "pro",
    emailVerified: true,
  });
  jest
    .mocked(assertUserCanMakeCostIncurringRequest)
    .mockRejectedValue(new ChatSDKError("forbidden:chat", "blocked"));
  expect((await POST(request())).status).toBe(403);
  expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
});
it("never probes cloud for a Desktop task and rejects traversal and unpinned downloads", async () => {
  jest
    .mocked(getChatById)
    .mockResolvedValue({ user_id: "owner", sandbox_type: "desktop" } as any);
  expect(await (await POST(request())).json()).toEqual({
    state: "disconnected",
    environmentLabel: "Local",
  });
  expect((await POST(request({ path: "../secret" }))).status).toBe(400);
  jest
    .mocked(getChatById)
    .mockResolvedValue({ user_id: "owner", sandbox_type: "e2b" } as any);
  expect(
    (await POST(request({ action: "download", path: "report.txt" }))).status,
  ).toBe(400);
  expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
});
it("returns private responses and suppresses raw provider errors", async () => {
  jest
    .mocked(accessCloudWorkspaceFiles)
    .mockRejectedValue(new Error("SECRET provider URL"));
  const response = await POST(request());
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error: "workspace_unavailable" });
});
it("bounds repeated workspace access before calling the provider", async () => {
  jest
    .mocked(createRedisClient)
    .mockReturnValue({ eval: async () => 121 } as any);
  const response = await POST(request());
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: "rate_limited" });
  expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
});
