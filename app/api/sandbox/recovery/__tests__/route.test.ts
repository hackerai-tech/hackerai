import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk";
import { GET, POST } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  confirmRecovery,
  recoveryView,
  reopenRecovery,
} from "@/lib/cloud-recovery/service";
import { failConsent } from "@/lib/cloud-recovery/store";
import { ChatSDKError } from "@/lib/errors";
jest.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: jest.fn() } }));
jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/lib/cloud-recovery/service", () => ({
  confirmRecovery: jest.fn(),
  recoveryView: jest.fn(),
  reopenRecovery: jest.fn(),
}));
jest.mock("@/lib/cloud-recovery/store", () => ({ failConsent: jest.fn() }));
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
const token = "7ad19af5-4d14-4d4b-aab7-90734610a6da";
const request = (body: unknown, origin = "https://preview.example.test") =>
  ({
    url: "https://preview.example.test/api/sandbox/recovery",
    headers: new Headers({ origin }),
    json: async () => body,
  }) as NextRequest;
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "session-owner",
    subscription: "pro",
    emailVerified: true,
  });
  jest.mocked(recoveryView).mockResolvedValue({ status: "recovering" });
  jest.mocked(failConsent).mockResolvedValue(undefined);
});
it("requires authentication and a cloud-enabled plan", async () => {
  jest
    .mocked(getUserIDAndPro)
    .mockRejectedValueOnce(new ChatSDKError("unauthorized:auth"));
  expect((await GET(request({}))).status).toBe(401);
  jest.mocked(getUserIDAndPro).mockResolvedValueOnce({
    userId: "free",
    subscription: "free",
    emailVerified: true,
  });
  expect((await POST(request({ token, confirmed: true }))).status).toBe(403);
  expect(confirmRecovery).not.toHaveBeenCalled();
});
it.each([
  { token, confirmed: true, userId: "victim" },
  { token, confirmed: true, sandboxId: "victim" },
  { token, confirmed: "true" },
  { token },
])("rejects client-supplied identity or implicit consent", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(tasks.trigger).not.toHaveBeenCalled();
});
it("requires same-origin confirmation", async () => {
  expect(
    (await POST(request({ token, confirmed: true }, "https://other.test")))
      .status,
  ).toBe(403);
  expect(confirmRecovery).not.toHaveBeenCalled();
});
it("dispatches using only server-owned consent and authenticated ownership", async () => {
  jest
    .mocked(confirmRecovery)
    .mockResolvedValue({ token, target: { region: "eu-central-1" } } as never);
  expect((await POST(request({ token, confirmed: true }))).status).toBe(202);
  expect(confirmRecovery).toHaveBeenCalledWith("session-owner", token, true);
  expect(tasks.trigger).toHaveBeenCalledWith(
    "cloud-workspace-recovery",
    { userId: "session-owner", token, region: "eu-central-1" },
    expect.objectContaining({
      region: "eu-central-1",
      idempotencyKey: `cloud-recovery:${token}`,
    }),
  );
});
it("a replay or decline never dispatches a second task", async () => {
  jest.mocked(confirmRecovery).mockResolvedValue(null);
  await POST(request({ token, confirmed: false }));
  await POST(request({ token, confirmed: true }));
  expect(tasks.trigger).not.toHaveBeenCalled();
});
it("treats an uncertain dispatch as support-only and does not retry", async () => {
  jest
    .mocked(confirmRecovery)
    .mockResolvedValueOnce({ token, target: { region: "us-east-1" } } as never)
    .mockResolvedValue(null);
  jest
    .mocked(tasks.trigger)
    .mockRejectedValueOnce(new Error("request timed out"));
  const response = await POST(request({ token, confirmed: true }));
  expect(await response.json()).toEqual({ status: "support" });
  expect(failConsent).toHaveBeenCalledWith("session-owner", token);
  await POST(request({ token, confirmed: true }));
  expect(tasks.trigger).toHaveBeenCalledTimes(1);
});

it("reopens a deferred warning without dispatching provider work", async () => {
  expect((await POST(request({ token, reopen: true }))).status).toBe(200);
  expect(reopenRecovery).toHaveBeenCalledWith("session-owner", token);
  expect(confirmRecovery).not.toHaveBeenCalled();
  expect(tasks.trigger).not.toHaveBeenCalled();
});
