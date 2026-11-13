/**
 * Tests for desktop-auth.ts — transfer token + OAuth state management.
 *
 * Covers:
 * - Token format validation
 * - Atomic get-and-delete (replay prevention)
 * - Transfer token creation, exchange, and edge cases
 * - OAuth state lifecycle
 * - Privacy-safe OAuth state lifecycle observations
 */

import { createHash } from "node:crypto";
import {
  createDesktopTransferToken,
  exchangeDesktopTransferToken,
  createOAuthState,
  verifyAndConsumeOAuthState,
} from "../desktop-auth";

const actualCrypto =
  jest.requireActual<typeof import("node:crypto")>("node:crypto");

// Call through to real hashing; individual tests can inject a hash failure.
jest.mock("node:crypto", () => {
  const actual =
    jest.requireActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, createHash: jest.fn(actual.createHash) };
});

// ── Mock Redis ──────────────────────────────────────────────────────────

const mockStore = new Map<string, { value: unknown; ttl?: number }>();

const mockRedis = {
  set: jest.fn(async (key: string, value: unknown, opts?: { ex?: number }) => {
    mockStore.set(key, { value, ttl: opts?.ex });
    return "OK";
  }),
  getdel: jest.fn(async <T>(key: string): Promise<T | null> => {
    const entry = mockStore.get(key);
    if (!entry) return null;
    mockStore.delete(key);
    return entry.value as T;
  }),
};

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => mockRedis),
}));

// Set env vars before importing the module
beforeAll(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
});

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

// ── Transfer Tokens ─────────────────────────────────────────────────────

describe("createDesktopTransferToken", () => {
  it("creates a 64-character hex token", async () => {
    const token = await createDesktopTransferToken("sealed-session-data");
    expect(token).not.toBeNull();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores the token in Redis with TTL", async () => {
    await createDesktopTransferToken("sealed-session-data");
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("desktop-auth-transfer:"),
      expect.objectContaining({
        sealedSession: "sealed-session-data",
        createdAt: expect.any(Number),
      }),
      { ex: 300 },
    );
  });

  it("stores the optional return path with the transfer token", async () => {
    await createDesktopTransferToken("sealed-session-data", {
      returnPath: "/#pricing",
    });
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("desktop-auth-transfer:"),
      expect.objectContaining({
        sealedSession: "sealed-session-data",
        returnPath: "/#pricing",
      }),
      { ex: 300 },
    );
  });

  it("stores the desktop auth state with the transfer token", async () => {
    const desktopAuthState = "c".repeat(64);
    await createDesktopTransferToken("sealed-session-data", {
      desktopAuthState,
    });
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("desktop-auth-transfer:"),
      expect.objectContaining({
        sealedSession: "sealed-session-data",
        desktopAuthState,
      }),
      { ex: 300 },
    );
  });

  it("generates unique tokens", async () => {
    const token1 = await createDesktopTransferToken("session1");
    const token2 = await createDesktopTransferToken("session2");
    expect(token1).not.toBe(token2);
  });
});

describe("exchangeDesktopTransferToken", () => {
  it("returns sealed session for valid token", async () => {
    const token = await createDesktopTransferToken("my-sealed-session");
    expect(token).not.toBeNull();

    const result = await exchangeDesktopTransferToken(token!);
    expect(result).toEqual({ sealedSession: "my-sealed-session" });
  });

  it("returns the preserved return path for valid token", async () => {
    const token = await createDesktopTransferToken("my-sealed-session", {
      returnPath: "/#pricing",
    });
    expect(token).not.toBeNull();

    const result = await exchangeDesktopTransferToken(token!);
    expect(result).toEqual({
      sealedSession: "my-sealed-session",
      returnPath: "/#pricing",
    });
  });

  it("returns sealed session when desktop auth state matches", async () => {
    const desktopAuthState = "d".repeat(64);
    const token = await createDesktopTransferToken("my-sealed-session", {
      desktopAuthState,
    });
    expect(token).not.toBeNull();

    const result = await exchangeDesktopTransferToken(token!, {
      desktopAuthState,
    });
    expect(result).toEqual({ sealedSession: "my-sealed-session" });
  });

  it("returns null when desktop auth state does not match", async () => {
    const token = await createDesktopTransferToken("my-sealed-session", {
      desktopAuthState: "e".repeat(64),
    });
    expect(token).not.toBeNull();

    const result = await exchangeDesktopTransferToken(token!, {
      desktopAuthState: "f".repeat(64),
    });
    expect(result).toBeNull();
  });

  it("returns null when a state-bound token is exchanged without desktop auth state", async () => {
    const token = await createDesktopTransferToken("my-sealed-session", {
      desktopAuthState: "a".repeat(64),
    });
    expect(token).not.toBeNull();

    const result = await exchangeDesktopTransferToken(token!);
    expect(result).toBeNull();
  });

  it("returns null for invalid token format", async () => {
    const result = await exchangeDesktopTransferToken("not-hex");
    expect(result).toBeNull();
    // Should not even hit Redis
    expect(mockRedis.getdel).not.toHaveBeenCalled();
  });

  it("returns null for too-short tokens", async () => {
    const result = await exchangeDesktopTransferToken("abcdef");
    expect(result).toBeNull();
  });

  it("returns null for expired/missing token", async () => {
    const validHex = "a".repeat(64);
    const result = await exchangeDesktopTransferToken(validHex);
    expect(result).toBeNull();
  });

  it("consumes token on first use (replay prevention)", async () => {
    const token = await createDesktopTransferToken("session-data");
    expect(token).not.toBeNull();

    // First exchange succeeds
    const first = await exchangeDesktopTransferToken(token!);
    expect(first).toEqual({ sealedSession: "session-data" });

    // Second exchange fails (token consumed)
    const second = await exchangeDesktopTransferToken(token!);
    expect(second).toBeNull();
  });
});

// ── OAuth State ─────────────────────────────────────────────────────────

describe("createOAuthState", () => {
  it("creates a 64-character hex state", async () => {
    const state = await createOAuthState();
    expect(state).not.toBeNull();
    expect(state).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores state without metadata as '1'", async () => {
    await createOAuthState();
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("desktop-oauth-state:"),
      "1",
      { ex: 300 },
    );
  });

  it("stores state with metadata as JSON", async () => {
    await createOAuthState({
      devCallbackPort: 3456,
      returnPath: "/#pricing",
      desktopAuthState: "a".repeat(64),
    });
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("desktop-oauth-state:"),
      JSON.stringify({
        devCallbackPort: 3456,
        returnPath: "/#pricing",
        desktopAuthState: "a".repeat(64),
      }),
      { ex: 300 },
    );
  });
});

describe("verifyAndConsumeOAuthState", () => {
  it("returns valid for a stored state (no metadata)", async () => {
    const state = await createOAuthState();
    expect(state).not.toBeNull();

    const result = await verifyAndConsumeOAuthState(state!);
    expect(result).toEqual({ valid: true });
  });

  it("returns valid with metadata for a stored state", async () => {
    const state = await createOAuthState({
      devCallbackPort: 9999,
      returnPath: "/#pricing",
      desktopAuthState: "b".repeat(64),
    });
    expect(state).not.toBeNull();

    const result = await verifyAndConsumeOAuthState(state!);
    expect(result.valid).toBe(true);
    expect(result.metadata).toEqual({
      devCallbackPort: 9999,
      returnPath: "/#pricing",
      desktopAuthState: "b".repeat(64),
    });
  });

  it("returns invalid for non-existent state", async () => {
    const validHex = "b".repeat(64);
    const result = await verifyAndConsumeOAuthState(validHex);
    expect(result).toEqual({ valid: false });
  });

  it("returns invalid for bad format", async () => {
    const result = await verifyAndConsumeOAuthState("invalid-format");
    expect(result).toEqual({ valid: false });
  });

  it("consumes state on first use", async () => {
    const state = await createOAuthState();
    expect(state).not.toBeNull();

    const first = await verifyAndConsumeOAuthState(state!);
    expect(first.valid).toBe(true);

    const second = await verifyAndConsumeOAuthState(state!);
    expect(second.valid).toBe(false);
  });
});

// ── OAuth State Lifecycle Observations ──────────────────────────────────

describe("OAuth state lifecycle observations", () => {
  const LIFECYCLE_EVENT = "desktop.oauth_state_lifecycle";
  const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const originalBuildCommit = process.env.VERCEL_GIT_COMMIT_SHA;
  let infoSpy: jest.SpyInstance;

  const infoLines = (): string[] =>
    infoSpy.mock.calls.map(([line]) => String(line));

  const lifecycleEvents = (): Record<string, unknown>[] =>
    infoLines()
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (event): event is Record<string, unknown> =>
          event?.event === LIFECYCLE_EVENT,
      );

  const expectedEvent = (phase: string, observationRef: unknown) => ({
    event: LIFECYCLE_EVENT,
    oauth_state_diagnostic_version: 1,
    phase,
    observation_ref: observationRef,
    ttl_seconds: 300,
    server_build_commit: BUILD_COMMIT,
  });

  beforeEach(() => {
    process.env.VERCEL_GIT_COMMIT_SHA = BUILD_COMMIT;
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    jest.mocked(createHash).mockImplementation(actualCrypto.createHash);
    if (originalBuildCommit === undefined) {
      delete process.env.VERCEL_GIT_COMMIT_SHA;
    } else {
      process.env.VERCEL_GIT_COMMIT_SHA = originalBuildCommit;
    }
  });

  it("links issuance, consumption and replay of one state through an opaque reference", async () => {
    const metadata = {
      devCallbackPort: 45123,
      returnPath: "/#canary-return-path",
      desktopAuthState: "5eed".repeat(16),
    };

    const state = await createOAuthState(metadata);
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    const first = await verifyAndConsumeOAuthState(state!);
    const replay = await verifyAndConsumeOAuthState(state!);

    // Observation must not alter the existing auth contract.
    expect(first).toEqual({ valid: true, metadata });
    expect(replay).toEqual({ valid: false });
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith(
      `desktop-oauth-state:${state}`,
      JSON.stringify(metadata),
      { ex: 300 },
    );
    expect(mockRedis.getdel).toHaveBeenCalledTimes(2);

    const events = lifecycleEvents();
    const observationRef = events[0]?.observation_ref;
    expect(observationRef).toMatch(/^[a-f0-9]{64}$/);
    expect(events).toEqual([
      expectedEvent("issued", observationRef),
      expectedEvent("consumed", observationRef),
      expectedEvent("lookup_empty", observationRef),
    ]);
    // One structured log line per completed Redis operation.
    expect(infoSpy).toHaveBeenCalledTimes(3);

    // The reference is domain-separated, not a reusable plain state digest.
    expect(observationRef).not.toBe(state);
    expect(observationRef).not.toBe(
      actualCrypto.createHash("sha256").update(state!).digest("hex"),
    );

    const logged = infoLines().join("\n");
    for (const secret of [
      state!,
      "desktop-oauth-state:",
      metadata.returnPath,
      metadata.desktopAuthState,
      String(metadata.devCallbackPort),
      "fake-token",
      "fake-redis.upstash.io",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("gives distinct generated states distinct references", async () => {
    const firstState = await createOAuthState();
    const secondState = await createOAuthState();
    expect(firstState).not.toBe(secondState);

    await verifyAndConsumeOAuthState(secondState!);

    const [firstIssued, secondIssued, secondConsumed] = lifecycleEvents();
    expect(firstIssued.phase).toBe("issued");
    expect(secondIssued.phase).toBe("issued");
    expect(firstIssued.observation_ref).not.toBe(secondIssued.observation_ref);
    expect(secondConsumed).toEqual(
      expectedEvent("consumed", secondIssued.observation_ref),
    );
  });

  it("does not claim issuance when Redis returns an unexpected SET acknowledgement", async () => {
    mockRedis.set.mockImplementationOnce(async (key, value, opts) => {
      mockStore.set(key, { value, ttl: opts?.ex });
      return null as unknown as "OK";
    });

    const state = await createOAuthState();

    // The existing contract still returns the state for any non-throwing SET.
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    const events = lifecycleEvents();
    expect(events).toEqual([
      expectedEvent("store_returned_other", events[0]?.observation_ref),
    ]);
    expect(events[0]?.observation_ref).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["missing", undefined],
    ["short", "0123456"],
    ["uppercase", BUILD_COMMIT.toUpperCase()],
    ["padded", ` ${BUILD_COMMIT}`],
    ["too long", `${BUILD_COMMIT}0`],
  ])(
    "reports a null server build commit when the value is %s",
    async (_label, commit) => {
      if (commit === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
      else process.env.VERCEL_GIT_COMMIT_SHA = commit;

      await createOAuthState();

      const events = lifecycleEvents();
      expect(events).toHaveLength(1);
      expect(events[0].server_build_commit).toBeNull();
    },
  );

  it("keeps create, consume and replay outcomes when the logger throws", async () => {
    infoSpy.mockImplementation(() => {
      throw new Error("log sink unavailable");
    });

    const state = await createOAuthState({ returnPath: "/#pricing" });
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyAndConsumeOAuthState(state!)).resolves.toEqual({
      valid: true,
      metadata: { returnPath: "/#pricing" },
    });
    await expect(verifyAndConsumeOAuthState(state!)).resolves.toEqual({
      valid: false,
    });
    // Each operation attempted its observation and swallowed the failure.
    expect(infoSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps create, consume and replay outcomes when hashing throws", async () => {
    jest.mocked(createHash).mockImplementation(() => {
      throw new Error("hash unavailable");
    });

    const state = await createOAuthState({ returnPath: "/#pricing" });
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyAndConsumeOAuthState(state!)).resolves.toEqual({
      valid: true,
      metadata: { returnPath: "/#pricing" },
    });
    await expect(verifyAndConsumeOAuthState(state!)).resolves.toEqual({
      valid: false,
    });
    expect(createHash).toHaveBeenCalled();
    expect(lifecycleEvents()).toEqual([]);
  });

  it("emits no lifecycle event for malformed state", async () => {
    const result = await verifyAndConsumeOAuthState("not-a-valid-state");

    expect(result).toEqual({ valid: false });
    expect(mockRedis.getdel).not.toHaveBeenCalled();
    expect(lifecycleEvents()).toEqual([]);
  });

  it("emits no lifecycle event when Redis is not configured", async () => {
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    try {
      await expect(createOAuthState()).resolves.toBeNull();
      await expect(verifyAndConsumeOAuthState("a".repeat(64))).resolves.toEqual(
        { valid: false },
      );
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = redisUrl;
    }

    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(mockRedis.getdel).not.toHaveBeenCalled();
    expect(lifecycleEvents()).toEqual([]);
  });

  it("emits no lifecycle event when Redis operations fail", async () => {
    mockRedis.set.mockRejectedValueOnce(new Error("set failed"));
    mockRedis.getdel.mockRejectedValueOnce(new Error("getdel failed"));

    await expect(createOAuthState()).resolves.toBeNull();
    await expect(verifyAndConsumeOAuthState("a".repeat(64))).resolves.toEqual({
      valid: false,
    });

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    expect(mockRedis.getdel).toHaveBeenCalledTimes(1);
    expect(lifecycleEvents()).toEqual([]);
  });

  it("does not observe desktop transfer tokens", async () => {
    const token = await createDesktopTransferToken("sealed-session-data");
    await exchangeDesktopTransferToken(token!);
    await exchangeDesktopTransferToken(token!);

    expect(lifecycleEvents()).toEqual([]);
  });
});
