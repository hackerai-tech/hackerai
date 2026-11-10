/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const query = jest.fn<any>();
const mutation = jest.fn<any>();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query, mutation }),
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    findingRetests: {
      getStateForBackend: "getState",
      saveRecipeForBackend: "save",
      startRunForBackend: "start",
      finishRunForBackend: "finish",
    },
  },
}));
const managerArgs: unknown[][] = [];
jest.mock("@/lib/ai/tools/utils/hybrid-sandbox-manager", () => ({
  HybridSandboxManager: jest.fn((...args: unknown[]) => {
    managerArgs.push(args);
    return { kind: "manager" };
  }),
}));
const acquire = jest.fn<any>();
jest.mock("@/lib/ai/tools/utils/sandbox-fallback", () => ({
  getSandboxWithFallbackGuard: (args: unknown) => acquire(args),
}));
const runner = jest.fn<any>();
jest.mock("../http-retest-runner", () => ({
  runHttpRetestInSandbox: (args: unknown) => runner(args),
}));
const events: Array<[string, Record<string, unknown>]> = [];
jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: (name: string, fields: Record<string, unknown>) =>
      events.push([name, fields]),
  },
}));

const SECRET = "eyJ-super-secret-token";

const recipe = {
  version: 1,
  title: "Invoice IDOR",
  origin: "https://app.example.test",
  timeout_ms: 8000,
  credentials: [{ name: "tester_token", label: "Tester", placement: "bearer" }],
  baselines: [
    {
      label: "Own",
      method: "GET",
      path: "/api/invoices/2",
      credential: "tester_token",
      headers: [],
      expect: {
        status: 200,
        json: [{ json_path: "owner_id", equals: "usr_tester_b" }],
        body_contains: [],
      },
    },
  ],
  probe: {
    label: "Victim",
    method: "GET",
    path: "/api/invoices/1",
    credential: "tester_token",
    headers: [],
    vulnerable: {
      status: 200,
      json: [{ json_path: "owner_id", equals: "usr_victim_a" }],
      body_contains: [],
    },
    not_reproduced: { statuses: [403, 404] },
  },
};

const run = {
  run_id: "run-1",
  request_id: "request-0001",
  status: "running",
  recipe_version: 3,
  recipe,
  started_at: 1,
};

const state = {
  available: true,
  finding: {
    sandbox_preference: "desktop-env",
    target: recipe.origin,
    chat_id: "chat-1",
  },
  recipe: { version: 3, recipe, source: "user", created_at: 1 },
  runs: [],
};

const localSandbox = {
  sandboxKind: "centrifugo",
  close: jest.fn<any>().mockResolvedValue(undefined),
  getConnectionInfo: () => ({ isDesktop: true, name: "MacBook Pro" }),
};

const observed = {
  kind: "observed",
  output: {
    protocol: 1,
    deadline_exceeded: false,
    steps: [
      {
        kind: "baseline",
        index: 0,
        status: 200,
        bytes: 10,
        body_sha256: "a".repeat(64),
        duration_ms: 3,
        error: "none",
        matched: true,
        checks: [true],
      },
      {
        kind: "probe",
        index: 0,
        status: 200,
        bytes: 10,
        body_sha256: "c".repeat(64),
        duration_ms: 3,
        error: "none",
        matched: true,
        checks: [true],
        nonreproduction_matched: false,
      },
    ],
  },
};

let environmentRevision: string;
const input = (overrides: Record<string, unknown> = {}) => ({
  userId: "user-1",
  subscription: "pro" as const,
  findingId: "finding-1",
  requestId: "request-0001",
  recipeVersion: 3,
  reviewedOrigin: "https://app.example.test",
  reviewedEnvironment: environmentRevision,
  credentials: { tester_token: SECRET },
  ...overrides,
});

describe("runHttpRetest", () => {
  let runHttpRetest: typeof import("../http-retest-service").runHttpRetest;

  beforeEach(async () => {
    jest.clearAllMocks();
    managerArgs.length = 0;
    events.length = 0;
    query.mockResolvedValue(state);
    mutation.mockImplementation(async (name: string, args: any) =>
      name === "start"
        ? {
            success: true,
            duplicate: false,
            run,
            sandbox_preference: "desktop-env",
          }
        : {
            success: true,
            run: { ...run, status: "finished", outcome: args.outcome },
          },
    );
    acquire.mockResolvedValue({ sandbox: localSandbox });
    runner.mockResolvedValue(observed);
    ({ runHttpRetest } = await import("../http-retest-service"));
    environmentRevision = (
      await import("../http-retest-service")
    ).httpRetestEnvironmentRevision("finding-1", "desktop-env");
  });

  it("runs on the source task's selected computer without fallback and finalizes once", async () => {
    const result = await runHttpRetest(input());
    expect(result).toMatchObject({
      success: true,
      run: { outcome: "reproduced" },
    });
    expect(managerArgs[0][2]).toBe("desktop-env");
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ requireLocalSandbox: true }),
    );
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { tester_token: SECRET } }),
    );
    const finishes = mutation.mock.calls.filter(([name]) => name === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0][1]).toMatchObject({
      outcome: "reproduced",
      reason: "vulnerable_predicate_matched",
      environment: { kind: "desktop", name: "MacBook Pro" },
      evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(localSandbox.close).toHaveBeenCalled();
  });

  it("never sends runtime credentials to Convex or analytics", async () => {
    await runHttpRetest(input());
    expect(JSON.stringify(mutation.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(query.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events[0]).toEqual([
      "finding_http_retest_finished",
      expect.objectContaining({ outcome: "reproduced", step_count: 2 }),
    ]);
  });

  it("records an error, without running, when the selected computer is unavailable", async () => {
    acquire.mockRejectedValue(new Error("offline"));
    const result = await runHttpRetest(input());
    expect(runner).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
    expect(
      mutation.mock.calls.find(([name]) => name === "finish")?.[1],
    ).toMatchObject({
      outcome: "error",
      reason: "sandbox_unavailable",
      steps: [],
    });
  });

  it("refuses a run whose reviewed origin or version is stale before claiming", async () => {
    expect(
      await runHttpRetest(input({ reviewedOrigin: "https://other.test" })),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(await runHttpRetest(input({ recipeVersion: 2 }))).toMatchObject({
      success: false,
      error: "conflict",
    });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("refuses a different computer revision without starting a command", async () => {
    expect(
      await runHttpRetest(input({ reviewedEnvironment: "f".repeat(64) })),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(mutation).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("requires exactly the recipe's credentials", async () => {
    expect(await runHttpRetest(input({ credentials: {} }))).toMatchObject({
      success: false,
      error: "validation",
    });
    expect(
      await runHttpRetest(
        input({ credentials: { tester_token: SECRET, extra: "x" } }),
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(
      await runHttpRetest(
        input({ credentials: { tester_token: `${SECRET}\r\nX-Injected: 1` } }),
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("does not execute a duplicate request again", async () => {
    mutation.mockResolvedValueOnce({
      success: true,
      duplicate: true,
      run: { ...run, status: "finished", outcome: "reproduced" },
      sandbox_preference: "desktop-env",
    });
    expect(await runHttpRetest(input())).toMatchObject({ success: true });
    expect(acquire).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("maps a missing runtime to skipped rather than not reproduced", async () => {
    runner.mockResolvedValue({ kind: "failed", reason: "runtime_unavailable" });
    await runHttpRetest(input());
    expect(
      mutation.mock.calls.find(([name]) => name === "finish")?.[1],
    ).toMatchObject({
      outcome: "skipped",
      reason: "runtime_unavailable",
    });
  });
});
