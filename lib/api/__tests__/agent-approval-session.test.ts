import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { createHash, createHmac } from "node:crypto";

const mockRunsCancel = jest.fn();
const mockSessionsClose = jest.fn();

class MockApiError extends Error {
  status?: number;

  constructor(status?: number) {
    super(`Trigger API error ${status ?? "unknown"}`);
    this.status = status;
  }
}

jest.mock("@trigger.dev/sdk", () => ({
  ApiError: MockApiError,
  runs: { cancel: mockRunsCancel },
  sessions: { close: mockSessionsClose },
}));

type CookieOptions = {
  name: string;
  value: string;
  [key: string]: unknown;
};

const createBrowserCookieJar = () => {
  const values = new Map<string, string>();
  const request = () =>
    ({
      cookies: {
        get: (name: string) => {
          const value = values.get(name);
          return value === undefined ? undefined : { name, value };
        },
        getAll: () => Array.from(values, ([name, value]) => ({ name, value })),
      },
    }) as any;
  const response = () =>
    ({
      cookies: {
        delete: jest.fn((name: string) => values.delete(name)),
        set: jest.fn((options: CookieOptions) => {
          values.set(options.name, options.value);
        }),
      },
    }) as any;
  return { request, response, values };
};

const encodeV1RefreshHandle = (
  input: {
    userId: string;
    chatId: string;
    runId: string;
    approvalSessionId: string;
  },
  expiresAt = Date.now() + 60_000,
) => {
  const payload = Buffer.from(
    JSON.stringify({ version: 1, ...input, expiresAt }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", "test-refresh-secret")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
};

describe("agent approval session lifecycle", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.AGENT_APPROVAL_REFRESH_SECRET = "test-refresh-secret";
    delete process.env.AGENT_APPROVAL_TOKEN_EXPIRATION;
    delete process.env.AGENT_TEMPORARY_APPROVAL_REFRESH_TTL_SECONDS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("uses a 15m production default and accepts a 1m E2E override", async () => {
    let approvalSessionModule = await import("../agent-approval-session");
    expect(approvalSessionModule.AGENT_APPROVAL_TOKEN_EXPIRATION).toBe("15m");

    jest.resetModules();
    process.env.AGENT_APPROVAL_TOKEN_EXPIRATION = "1m";
    approvalSessionModule = await import("../agent-approval-session");
    expect(approvalSessionModule.AGENT_APPROVAL_TOKEN_EXPIRATION).toBe("1m");
  });

  it("round-trips an HttpOnly temporary mapping bound to user and chat", async () => {
    const {
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const browser = createBrowserCookieJar();
    const response = browser.response();

    setTemporaryAgentApprovalRefreshCookie(response, {
      req: browser.request(),
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });

    expect(response.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "hai_agent_approval",
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      }),
    );
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-1",
      }),
    ).toEqual({
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "other-user",
        chatId: "temporary-chat-1",
      }),
    ).toBeNull();
  });

  it("rejects a tampered temporary refresh mapping", async () => {
    const {
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const browser = createBrowserCookieJar();
    setTemporaryAgentApprovalRefreshCookie(browser.response(), {
      req: browser.request(),
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });

    const value = browser.values.get("hai_agent_approval");
    browser.values.set("hai_agent_approval", `${value}tampered`);
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-1",
      }),
    ).toBeNull();
  });

  it("preserves concurrent temporary chats through browser cookie overwrites", async () => {
    const {
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const browser = createBrowserCookieJar();

    setTemporaryAgentApprovalRefreshCookie(browser.response(), {
      req: browser.request(),
      userId: "user-1",
      chatId: "temporary-chat-a",
      runId: "run-a",
      approvalSessionId: "approval-session-a",
    });
    setTemporaryAgentApprovalRefreshCookie(browser.response(), {
      req: browser.request(),
      userId: "user-1",
      chatId: "temporary-chat-b",
      runId: "run-b",
      approvalSessionId: "approval-session-b",
    });

    expect(browser.values.size).toBe(1);
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-a",
      }),
    ).toMatchObject({ runId: "run-a" });
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-b",
      }),
    ).toMatchObject({ runId: "run-b" });
  });

  it("refreshes by chat without replacing another tab's mapping", async () => {
    const {
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const browser = createBrowserCookieJar();

    for (const mapping of [
      {
        chatId: "temporary-chat-a",
        runId: "run-a-old",
        approvalSessionId: "approval-session-a-old",
      },
      {
        chatId: "temporary-chat-b",
        runId: "run-b",
        approvalSessionId: "approval-session-b",
      },
      {
        chatId: "temporary-chat-a",
        runId: "run-a-new",
        approvalSessionId: "approval-session-a-new",
      },
    ]) {
      setTemporaryAgentApprovalRefreshCookie(browser.response(), {
        req: browser.request(),
        userId: "user-1",
        ...mapping,
      });
    }

    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-a",
      }),
    ).toMatchObject({
      runId: "run-a-new",
      approvalSessionId: "approval-session-a-new",
    });
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-b",
      }),
    ).toMatchObject({ runId: "run-b" });
  });

  it("keeps the shared cookie below its byte and mapping limits", async () => {
    const {
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const browser = createBrowserCookieJar();

    for (let index = 0; index < 100; index++) {
      setTemporaryAgentApprovalRefreshCookie(browser.response(), {
        req: browser.request(),
        userId: "user-1",
        chatId: `temporary-chat-${index}`,
        runId: `run-${index}`,
        approvalSessionId: `approval-session-${index}`,
      });
    }

    expect(browser.values.size).toBe(1);
    expect(
      Buffer.byteLength(browser.values.get("hai_agent_approval") ?? "", "utf8"),
    ).toBeLessThanOrEqual(3500);
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-91",
      }),
    ).toBeNull();
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-99",
      }),
    ).toMatchObject({ runId: "run-99" });
  });

  it("keeps the temporary mapping valid after the 15m public token expires", async () => {
    const {
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const startedAt = Date.UTC(2026, 6, 12, 12);
    const now = jest.spyOn(Date, "now").mockReturnValue(startedAt);
    const browser = createBrowserCookieJar();
    setTemporaryAgentApprovalRefreshCookie(browser.response(), {
      req: browser.request(),
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
    now.mockReturnValue(startedAt + 16 * 60 * 1000);

    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-1",
      }),
    ).toEqual({
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
    now.mockRestore();
  });

  it("migrates v1 single-handle and legacy per-chat cookies into v2", async () => {
    const {
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const browser = createBrowserCookieJar();
    browser.values.set(
      "hai_agent_approval",
      encodeV1RefreshHandle({
        userId: "user-1",
        chatId: "temporary-chat-v1",
        runId: "run-v1",
        approvalSessionId: "approval-session-v1",
      }),
    );
    const legacyChatId = "temporary-chat-legacy";
    const legacyName = `hai_agent_approval_${createHash("sha256")
      .update(legacyChatId)
      .digest("hex")
      .slice(0, 24)}`;
    browser.values.set(
      legacyName,
      encodeV1RefreshHandle({
        userId: "user-1",
        chatId: legacyChatId,
        runId: "run-legacy",
        approvalSessionId: "approval-session-legacy",
      }),
    );
    const response = browser.response();
    setTemporaryAgentApprovalRefreshCookie(response, {
      req: browser.request(),
      userId: "user-1",
      chatId: "temporary-chat-new",
      runId: "run-new",
      approvalSessionId: "approval-session-new",
    });

    for (const [chatId, runId] of [
      ["temporary-chat-v1", "run-v1"],
      [legacyChatId, "run-legacy"],
      ["temporary-chat-new", "run-new"],
    ]) {
      expect(
        getTemporaryAgentApprovalRefreshHandle({
          req: browser.request(),
          userId: "user-1",
          chatId,
        }),
      ).toMatchObject({ runId });
    }
    expect(browser.values.has(legacyName)).toBe(false);
    expect(response.cookies.delete).toHaveBeenCalledWith(legacyName);
  });

  it("removes only the targeted mapping while preserving another tab", async () => {
    const {
      clearTemporaryAgentApprovalRefreshCookie,
      getTemporaryAgentApprovalRefreshHandle,
      setTemporaryAgentApprovalRefreshCookie,
    } = await import("../agent-approval-session");
    const browser = createBrowserCookieJar();
    for (const suffix of ["a", "b"]) {
      setTemporaryAgentApprovalRefreshCookie(browser.response(), {
        req: browser.request(),
        userId: "user-1",
        chatId: `temporary-chat-${suffix}`,
        runId: `run-${suffix}`,
        approvalSessionId: `approval-session-${suffix}`,
      });
    }

    const response = browser.response();
    clearTemporaryAgentApprovalRefreshCookie(response, {
      req: browser.request(),
      userId: "user-1",
      chatId: "temporary-chat-a",
    });

    expect(response.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "hai_agent_approval" }),
    );
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-a",
      }),
    ).toBeNull();
    expect(
      getTemporaryAgentApprovalRefreshHandle({
        req: browser.request(),
        userId: "user-1",
        chatId: "temporary-chat-b",
      }),
    ).toMatchObject({ runId: "run-b" });
  });

  it("treats already-terminal cleanup as success but rethrows outages", async () => {
    const { cancelAgentTriggerRun, closeAgentApprovalSession } =
      await import("../agent-approval-session");
    mockRunsCancel.mockRejectedValueOnce(new MockApiError(404) as never);
    mockSessionsClose.mockRejectedValueOnce(new MockApiError(409) as never);

    await expect(cancelAgentTriggerRun("run-1")).resolves.toBe(true);
    await expect(
      closeAgentApprovalSession("approval-session-1", "chat-deleted"),
    ).resolves.toBe(true);

    mockRunsCancel.mockRejectedValueOnce(new MockApiError(503) as never);
    await expect(cancelAgentTriggerRun("run-2")).rejects.toMatchObject({
      status: 503,
    });
  });
});
