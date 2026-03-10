/**
 * Tests for desktop-auth.ts — transfer token + OAuth state management.
 *
 * Covers:
 * - Token format validation
 * - Atomic get-and-delete (replay prevention)
 * - Transfer token creation, exchange, and edge cases
 * - OAuth state lifecycle
 */

import {
  createDesktopTransferToken,
  exchangeDesktopTransferToken,
  createOAuthState,
  verifyAndConsumeOAuthState,
} from "../desktop-auth";

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
    await createOAuthState({ devCallbackPort: 3456 });
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("desktop-oauth-state:"),
      JSON.stringify({ devCallbackPort: 3456 }),
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
    const state = await createOAuthState({ devCallbackPort: 9999 });
    expect(state).not.toBeNull();

    const result = await verifyAndConsumeOAuthState(state!);
    expect(result.valid).toBe(true);
    expect(result.metadata).toEqual({ devCallbackPort: 9999 });
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
