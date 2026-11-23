import type { NextRequest } from "next/server";
import { accessLocalWorkspaceFiles } from "@/lib/sandbox/local-workspace-files";
import { resolveProjectExecutionContext } from "@/lib/chat/project-context";
import { getConvexClient } from "@/lib/db/convex-client";
import { GET, POST } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById, getProjectById } from "@/lib/db/actions";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import { accessCloudWorkspaceFiles } from "@/lib/sandbox/cloud-workspace-files";
import {
  assertUserCanAccessChatHistory,
  assertUserCanMakeCostIncurringRequest,
} from "@/lib/suspensions";
import { ChatSDKError } from "@/lib/errors";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { WorkspaceFileError } from "@/lib/sandbox/workspace-files";

jest.mock("@/lib/sandbox/local-workspace-files", () => ({
  accessLocalWorkspaceFiles: jest.fn(),
}));
jest.mock("@/lib/chat/project-context", () => ({
  resolveProjectExecutionContext: jest.fn().mockResolvedValue({}),
}));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/db/actions", () => ({
  getChatById: jest.fn(),
  getProjectById: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
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
// Lets the history-guard tests below load the real shared guard.
jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));
const makeRequest = (
  url: string,
  body?: unknown,
  signal = new AbortController().signal,
) =>
  ({
    nextUrl: new URL(url),
    headers: new Headers({ origin: "https://preview.example" }),
    signal,
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
  process.env.CONVEX_SERVICE_ROLE_KEY = "test";
  jest.mocked(getConvexClient).mockReturnValue({
    query: jest.fn(async (_ref, args) => args.preference),
  } as any);
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

it("normalizes a legacy Desktop connection before checking its linked project folder", async () => {
  jest.mocked(getChatById).mockResolvedValue({
    user_id: "owner",
    sandbox_type: "legacy-session",
    project_id: "project",
  } as any);
  jest
    .mocked(getProjectById)
    .mockResolvedValue({ folder_path: "/Users/test/project" } as any);
  jest
    .mocked(resolveProjectExecutionContext)
    .mockImplementation(
      jest.requireActual("@/lib/chat/project-context")
        .resolveProjectExecutionContext,
    );
  const query = jest.fn().mockResolvedValue("desktop-environment:machine");
  jest.mocked(getConvexClient).mockReturnValue({ query } as any);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(query).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ userId: "owner", preference: "legacy-session" }),
  );
  expect(accessLocalWorkspaceFiles).toHaveBeenCalledWith(
    "owner",
    "desktop-environment:machine",
    expect.anything(),
    "/Users/test/project",
  );
  expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
});

describe("POST rejection diagnostics", () => {
  // Every user-controlled or identifying value below carries this marker.
  const MARKER = "7f3e9c";
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.mocked(getUserIDAndPro).mockResolvedValue({
      userId: `user-${MARKER}`,
      subscription: "pro",
      emailVerified: true,
    });
    jest.mocked(getChatById).mockResolvedValue({
      user_id: `user-${MARKER}`,
      sandbox_type: "e2b",
    } as any);
  });
  afterEach(() => warn.mockRestore());

  const sensitive = (values = {}) =>
    request({ chatId: `chat-${MARKER}`, ...values });
  const rawRequest = (text: string, origin = "https://preview.example") =>
    ({
      nextUrl: new URL(
        `https://preview.example/api/workspace-files?q=${MARKER}`,
      ),
      headers: new Headers({ origin }),
      text: async () => text,
    }) as unknown as NextRequest;
  const expectRejection = async (
    response: Response | Promise<Response>,
    status: number,
    error: string,
    fields: Record<string, unknown>,
  ) => {
    const resolved = await response;
    expect(resolved.status).toBe(status);
    expect(await resolved.json()).toEqual({ error });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain(MARKER);
    expect(JSON.parse(line)).toEqual({
      event: "workspace_files_request_rejected",
      status,
      ...fields,
    });
    warn.mockClear();
  };

  it("names each request validation failure without request values", async () => {
    await expectRejection(
      POST(rawRequest("{}", `https://${MARKER}.example`)),
      403,
      "forbidden",
      { reason: "origin_mismatch" },
    );
    await expectRejection(
      POST(rawRequest(`"${MARKER}${"x".repeat(8192)}"`)),
      400,
      "invalid_request",
      { reason: "body_too_large" },
    );
    await expectRejection(
      POST(rawRequest(`{"${MARKER}":`)),
      400,
      "invalid_request",
      { reason: "malformed_json" },
    );
    await expectRejection(
      POST(sensitive({ action: "preview", path: `../${MARKER}` })),
      400,
      "invalid_request",
      {
        reason: "invalid_schema",
        action: "preview",
        field: "path",
        issue_code: "custom",
        issue_count: 1,
      },
    );
    // Unrecognized property names are user-controlled and must not be logged.
    await expectRejection(
      POST(sensitive({ action: MARKER, [MARKER]: MARKER })),
      400,
      "invalid_request",
      {
        reason: "invalid_schema",
        field: "action",
        issue_code: "invalid_value",
        issue_count: 2,
      },
    );
    await expectRejection(
      POST(sensitive({ action: "download", path: `${MARKER}.txt` })),
      400,
      "invalid_request",
      { reason: "sandbox_id_missing", action: "download" },
    );
    expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("distinguishes access, history, subscription and cost-suspension gates", async () => {
    jest.mocked(getChatById).mockResolvedValueOnce({ user_id: "other" } as any);
    await expectRejection(POST(sensitive()), 404, "not_found", {
      reason: "chat_not_owned",
      stage: "chat",
      action: "list",
    });
    jest
      .mocked(getPostHogBooleanFlagDecisionForUser)
      .mockResolvedValueOnce(false);
    await expectRejection(POST(sensitive()), 404, "unavailable", {
      reason: "flag_unavailable",
      stage: "feature_flag",
      action: "list",
    });
    jest
      .mocked(assertUserCanAccessChatHistory)
      .mockRejectedValueOnce(
        new ChatSDKError("forbidden:chat", `suspended ${MARKER}`),
      );
    await expectRejection(POST(sensitive()), 403, "forbidden", {
      reason: "history_access_denied",
      stage: "history_access",
      action: "list",
      error_type: "forbidden",
      error_surface: "chat",
    });
    jest
      .mocked(assertUserCanMakeCostIncurringRequest)
      .mockRejectedValueOnce(
        new ChatSDKError("forbidden:chat", `suspended ${MARKER}`),
      );
    await expectRejection(POST(sensitive()), 403, "forbidden", {
      reason: "cost_suspended",
      stage: "cost_gate",
      action: "list",
      error_type: "forbidden",
      error_surface: "chat",
    });
    jest.mocked(getUserIDAndPro).mockResolvedValueOnce({
      userId: `user-${MARKER}`,
      subscription: "free",
      emailVerified: true,
    });
    await expectRejection(POST(sensitive()), 403, "subscription_required", {
      reason: "subscription_required",
      action: "list",
    });
    expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("logs known sandbox codes and only a fixed fallback for provider errors", async () => {
    const preview = {
      action: "preview",
      sandboxId: `sbx-${MARKER}`,
      path: `${MARKER}.txt`,
    };
    jest
      .mocked(accessCloudWorkspaceFiles)
      .mockRejectedValueOnce(new WorkspaceFileError("file_too_large", 400));
    await expectRejection(POST(sensitive(preview)), 400, "file_too_large", {
      reason: "workspace_file_error",
      stage: "workspace",
      action: "preview",
      error_code: "file_too_large",
    });
    jest
      .mocked(accessCloudWorkspaceFiles)
      .mockRejectedValueOnce(
        new TypeError(`https://${MARKER}.e2b.dev/home/user/${MARKER}`),
      );
    await expectRejection(
      POST(sensitive(preview)),
      503,
      "workspace_unavailable",
      {
        reason: "unexpected_error",
        stage: "workspace",
        action: "preview",
        error_name: "TypeError",
      },
    );
  });

  it("adds adapter list diagnostics to the log without changing the public error", async () => {
    jest.mocked(accessCloudWorkspaceFiles).mockRejectedValueOnce(
      new WorkspaceFileError("unreadable_path", 400, {
        reader: "cloud",
        reader_phase: "entry_stat",
        os_error_category: "permission",
      }),
    );
    await expectRejection(
      POST(sensitive({ path: `${MARKER}/reports` })),
      400,
      "unreadable_path",
      {
        reason: "workspace_file_error",
        stage: "workspace",
        action: "list",
        error_code: "unreadable_path",
        reader: "cloud",
        reader_phase: "entry_stat",
        os_error_category: "permission",
      },
    );
  });

  it("does not log successful requests", async () => {
    expect((await POST(sensitive())).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves the original rejection when writing diagnostics throws", async () => {
    warn.mockImplementation(() => {
      throw new Error("Log transport unavailable");
    });
    const response = await POST(rawRequest("{"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("history guard transport failures", () => {
  // Runs the real shared guard; only the Convex query boundary is replaced.
  const query = jest.fn();
  const block = {
    category: "dispute_fraudulent",
    source: "stripe",
    source_id: "dp_1",
  };
  const fetchFailed = () => new TypeError("fetch failed");
  const probe = (signal?: AbortSignal) =>
    GET(
      makeRequest(
        "https://preview.example/api/workspace-files?chatId=chat",
        undefined,
        signal,
      ),
    );
  const expectNoDownstreamAccess = () => {
    expect(getChatById).not.toHaveBeenCalled();
    expect(getPostHogBooleanFlagDecisionForUser).not.toHaveBeenCalled();
    expect(accessCloudWorkspaceFiles).not.toHaveBeenCalled();
    expect(accessLocalWorkspaceFiles).not.toHaveBeenCalled();
  };
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest
      .mocked(assertUserCanAccessChatHistory)
      .mockImplementation(
        jest.requireActual("@/lib/suspensions").assertUserCanAccessChatHistory,
      );
    jest.mocked(getConvexClient).mockReturnValue({ query } as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it("enables the probe only after one transient read is retried clear", async () => {
    query.mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(null);
    const response = await probe();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual({
      serviceKey: "test",
      userId: "owner",
    });
    const retryOrder = query.mock.invocationCallOrder[1];
    expect(
      jest.mocked(getChatById).mock.invocationCallOrder[0],
    ).toBeGreaterThan(retryOrder);
    expect(
      jest.mocked(getPostHogBooleanFlagDecisionForUser).mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(retryOrder);
  });

  it("keeps a block returned by the retry as a denial", async () => {
    query.mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(block);
    const response = await probe();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(query).toHaveBeenCalledTimes(2);
    expectNoDownstreamAccess();
  });

  it("fails closed after two transient reads", async () => {
    query
      .mockRejectedValueOnce(fetchFailed())
      .mockRejectedValueOnce(fetchFailed())
      .mockResolvedValueOnce(null);
    const response = await probe();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "workspace_unavailable" });
    expect(query).toHaveBeenCalledTimes(2);
    expectNoDownstreamAccess();
  });

  it("starts no retry after the request is aborted", async () => {
    // Abort delivered while the first read is in flight.
    const inFlight = new AbortController();
    query.mockImplementationOnce(async () => {
      inFlight.abort();
      throw fetchFailed();
    });
    expect((await probe(inFlight.signal)).status).toBe(503);
    expect(query).toHaveBeenCalledTimes(1);

    // Abort delivered during the retry backoff.
    query.mockClear();
    const backoff = new AbortController();
    warn.mockImplementation((line: string) => {
      if (line.includes('"event":"history_access_gate_read_retry"'))
        queueMicrotask(() => backoff.abort());
    });
    query.mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(null);
    expect((await probe(backoff.signal)).status).toBe(503);
    expect(query).toHaveBeenCalledTimes(1);
    expectNoDownstreamAccess();
  });

  it.each([
    ["an application denial", block, 403, "forbidden"],
    [
      "a non-native fetch error",
      new Error("fetch failed"),
      503,
      "workspace_unavailable",
    ],
    [
      "an unknown TypeError",
      new TypeError("parser failure"),
      503,
      "workspace_unavailable",
    ],
  ])("does not retry %s", async (_name, outcome, status, error) => {
    if (outcome instanceof Error) query.mockRejectedValueOnce(outcome);
    else query.mockResolvedValueOnce(outcome);
    query.mockResolvedValueOnce(null);
    const response = await probe();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(query).toHaveBeenCalledTimes(1);
    expectNoDownstreamAccess();
  });

  it("keeps POST on a single history read", async () => {
    query.mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(null);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "workspace_unavailable" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toEqual({
      event: "workspace_files_request_rejected",
      status: 503,
      action: "list",
      reason: "unexpected_error",
      stage: "history_access",
      error_name: "TypeError",
    });
    expectNoDownstreamAccess();
  });
});
