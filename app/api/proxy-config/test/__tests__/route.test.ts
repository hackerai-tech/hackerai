import type { NextRequest } from "next/server";
import { POST } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getUserProxyConfigForBackend } from "@/lib/db/actions";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";

const runCommand = jest.fn();
const getSandbox = jest.fn(async () => ({
  sandbox: { commands: { run: runCommand } },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: jest.fn(),
}));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock("@/lib/db/actions", () => ({
  getUserProxyConfigForBackend: jest.fn(),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/sandbox-manager", () => ({
  DefaultSandboxManager: jest.fn().mockImplementation(() => ({ getSandbox })),
}));

const proxyConfig = {
  protocol: "http" as const,
  host: "proxy.example.com",
  port: 8443,
  username: "alice",
  password: "secret",
  proxyDns: true,
  bypassHosts: [],
  updatedAt: 1234,
};

describe("POST /api/proxy-config/test", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getUserIDAndPro as jest.Mock).mockResolvedValue({
      userId: "user_123",
      subscription: "pro",
    });
    (getUserProxyConfigForBackend as jest.Mock).mockResolvedValue(proxyConfig);
    runCommand.mockResolvedValue({
      stdout: "203.0.113.42\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("tests the saved proxy from the user's E2B sandbox", async () => {
    const response = await POST({} as NextRequest);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      exitIp: "203.0.113.42",
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.stringContaining("https://api.ipify.org"),
      expect.objectContaining({
        user: "root",
        cwd: "/home/user",
        envs: expect.objectContaining({
          HTTPS_PROXY: expect.stringContaining("alice:secret@"),
        }),
      }),
    );
    expect(assertUserCanMakeCostIncurringRequest).toHaveBeenCalledWith(
      "user_123",
    );
  });

  it("rejects free plans before creating a sandbox", async () => {
    (getUserIDAndPro as jest.Mock).mockResolvedValue({
      userId: "user_123",
      subscription: "free",
    });

    const response = await POST({} as NextRequest);

    expect(response.status).toBe(403);
    expect(assertUserCanMakeCostIncurringRequest).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("does not bypass the proxy for the diagnostic host", async () => {
    (getUserProxyConfigForBackend as jest.Mock).mockResolvedValue({
      ...proxyConfig,
      bypassHosts: ["api.ipify.org"],
    });

    await POST({} as NextRequest);

    expect(runCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        envs: expect.objectContaining({
          NO_PROXY: "",
          no_proxy: "",
        }),
      }),
    );
  });

  it("does not return arbitrary command output as an exit IP", async () => {
    runCommand.mockResolvedValue({
      stdout: "proxy provider diagnostic with credentials",
      stderr: "",
      exitCode: 0,
    });

    const response = await POST({} as NextRequest);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "The proxy did not return a valid public IP address",
    });
  });
});
