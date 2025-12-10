import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  getSharedToken,
  setSharedToken,
  clearExpiredSharedToken,
  isTokenFresh,
  clearSharedToken,
  getFreshSharedToken,
  getFreshSharedTokenWithFallback,
  SHARED_TOKEN_KEY,
  TOKEN_FRESHNESS_MS,
  SharedToken,
} from "../shared-token";

describe("shared-token", () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    jest.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
      return mockStorage[key] ?? null;
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      mockStorage[key] = value;
    });
    jest.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
      delete mockStorage[key];
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("constants", () => {
    it("should have correct SHARED_TOKEN_KEY", () => {
      expect(SHARED_TOKEN_KEY).toBe("hackerai-shared-token");
    });

    it("should have TOKEN_FRESHNESS_MS set to 60 seconds", () => {
      expect(TOKEN_FRESHNESS_MS).toBe(60000);
    });
  });

  describe("getSharedToken", () => {
    it("should return null when no token exists", () => {
      const result = getSharedToken();
      expect(result).toBeNull();
    });

    it("should return parsed token when valid data exists", () => {
      const tokenData: SharedToken = {
        token: "test-token-123",
        refreshedAt: Date.now(),
      };
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify(tokenData);

      const result = getSharedToken();

      expect(result).toEqual(tokenData);
    });

    it("should return null when localStorage contains invalid JSON", () => {
      mockStorage[SHARED_TOKEN_KEY] = "not valid json";

      const result = getSharedToken();

      expect(result).toBeNull();
    });

    it("should return null when localStorage throws error", () => {
      jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Storage error");
      });

      const result = getSharedToken();

      expect(result).toBeNull();
    });
  });

  describe("setSharedToken", () => {
    it("should store token with current timestamp", () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      setSharedToken("my-token");

      const stored = JSON.parse(mockStorage[SHARED_TOKEN_KEY]);
      expect(stored.token).toBe("my-token");
      expect(stored.refreshedAt).toBe(now);
    });

    it("should overwrite existing token", () => {
      setSharedToken("first-token");
      setSharedToken("second-token");

      const stored = JSON.parse(mockStorage[SHARED_TOKEN_KEY]);
      expect(stored.token).toBe("second-token");
    });

    it("should handle localStorage errors gracefully", () => {
      jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("Storage full");
      });

      expect(() => setSharedToken("test")).not.toThrow();
    });
  });

  describe("clearExpiredSharedToken", () => {
    it("should remove token when expired", () => {
      const expiredTime = Date.now() - TOKEN_FRESHNESS_MS - 1000;
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify({
        token: "old-token",
        refreshedAt: expiredTime,
      });

      clearExpiredSharedToken();

      expect(mockStorage[SHARED_TOKEN_KEY]).toBeUndefined();
    });

    it("should keep token when still fresh", () => {
      const freshTime = Date.now() - TOKEN_FRESHNESS_MS + 10000;
      const tokenData = {
        token: "fresh-token",
        refreshedAt: freshTime,
      };
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify(tokenData);

      clearExpiredSharedToken();

      expect(mockStorage[SHARED_TOKEN_KEY]).toBeDefined();
    });

    it("should do nothing when no token exists", () => {
      expect(() => clearExpiredSharedToken()).not.toThrow();
    });

    it("should handle corrupted JSON gracefully", () => {
      mockStorage[SHARED_TOKEN_KEY] = "not json";

      expect(() => clearExpiredSharedToken()).not.toThrow();
    });

    it("should handle localStorage errors gracefully", () => {
      jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Storage error");
      });

      expect(() => clearExpiredSharedToken()).not.toThrow();
    });

    it("should remove token exactly at the freshness boundary", () => {
      const exactlyExpired = Date.now() - TOKEN_FRESHNESS_MS;
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify({
        token: "boundary-token",
        refreshedAt: exactlyExpired,
      });

      clearExpiredSharedToken();

      expect(mockStorage[SHARED_TOKEN_KEY]).toBeUndefined();
    });
  });

  describe("isTokenFresh", () => {
    it("should return false for null token", () => {
      expect(isTokenFresh(null)).toBe(false);
    });

    it("should return true for recently refreshed token", () => {
      const freshToken: SharedToken = {
        token: "fresh",
        refreshedAt: Date.now() - 1000, // 1 second ago
      };

      expect(isTokenFresh(freshToken)).toBe(true);
    });

    it("should return false for expired token", () => {
      const expiredToken: SharedToken = {
        token: "expired",
        refreshedAt: Date.now() - TOKEN_FRESHNESS_MS - 1000, // 61 seconds ago
      };

      expect(isTokenFresh(expiredToken)).toBe(false);
    });

    it("should return false at exact boundary", () => {
      const boundaryToken: SharedToken = {
        token: "boundary",
        refreshedAt: Date.now() - TOKEN_FRESHNESS_MS, // exactly 60 seconds ago
      };

      expect(isTokenFresh(boundaryToken)).toBe(false);
    });

    it("should return true just before boundary", () => {
      const almostExpiredToken: SharedToken = {
        token: "almost",
        refreshedAt: Date.now() - TOKEN_FRESHNESS_MS + 1, // 59.999 seconds ago
      };

      expect(isTokenFresh(almostExpiredToken)).toBe(true);
    });
  });

  describe("getFreshSharedToken", () => {
    it("should return token when fresh", () => {
      const tokenData: SharedToken = {
        token: "fresh-token",
        refreshedAt: Date.now() - 1000,
      };
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify(tokenData);

      const result = getFreshSharedToken();

      expect(result).toBe("fresh-token");
    });

    it("should return null when token is expired", () => {
      const tokenData: SharedToken = {
        token: "expired-token",
        refreshedAt: Date.now() - TOKEN_FRESHNESS_MS - 1000,
      };
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify(tokenData);

      const result = getFreshSharedToken();

      expect(result).toBeNull();
    });

    it("should return null when no token exists", () => {
      const result = getFreshSharedToken();

      expect(result).toBeNull();
    });

    it("should return null when localStorage has invalid data", () => {
      mockStorage[SHARED_TOKEN_KEY] = "invalid json";

      const result = getFreshSharedToken();

      expect(result).toBeNull();
    });
  });

  describe("clearSharedToken", () => {
    it("should remove token from localStorage", () => {
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify({
        token: "test",
        refreshedAt: Date.now(),
      });

      clearSharedToken();

      expect(mockStorage[SHARED_TOKEN_KEY]).toBeUndefined();
    });

    it("should handle non-existent token gracefully", () => {
      expect(() => clearSharedToken()).not.toThrow();
    });

    it("should handle localStorage errors gracefully", () => {
      jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("Storage error");
      });

      expect(() => clearSharedToken()).not.toThrow();
    });
  });

  describe("cross-tab token sharing scenarios", () => {
    it("should allow multiple tabs to read the same shared token", () => {
      // Tab A sets token
      setSharedToken("shared-token-abc");

      // Tab B reads it
      const tabBResult = getSharedToken();
      expect(tabBResult?.token).toBe("shared-token-abc");

      // Tab C reads it
      const tabCResult = getSharedToken();
      expect(tabCResult?.token).toBe("shared-token-abc");
    });

    it("should allow newer token to overwrite older one", () => {
      const oldTime = Date.now() - 30000;
      jest.spyOn(Date, "now").mockReturnValueOnce(oldTime);
      setSharedToken("old-token");

      jest.spyOn(Date, "now").mockReturnValue(Date.now());
      setSharedToken("new-token");

      const result = getSharedToken();
      expect(result?.token).toBe("new-token");
      expect(result?.refreshedAt).toBeGreaterThan(oldTime);
    });

    it("should correctly identify fresh vs stale tokens in race conditions", () => {
      // Simulate Tab A setting a token
      const tabATime = Date.now();
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify({
        token: "tab-a-token",
        refreshedAt: tabATime,
      });

      // Tab B checks if token is fresh (should be true)
      const sharedToken = getSharedToken();
      expect(isTokenFresh(sharedToken)).toBe(true);

      // Simulate time passing past freshness window
      jest.spyOn(Date, "now").mockReturnValue(tabATime + TOKEN_FRESHNESS_MS + 1000);

      // Tab C checks freshness (should now be false)
      const staleCheck = isTokenFresh(sharedToken);
      expect(staleCheck).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string token", () => {
      setSharedToken("");

      const result = getSharedToken();
      expect(result?.token).toBe("");
    });

    it("should handle very long tokens", () => {
      const longToken = "x".repeat(10000);
      setSharedToken(longToken);

      const result = getSharedToken();
      expect(result?.token).toBe(longToken);
    });

    it("should handle tokens with special characters", () => {
      const specialToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
      setSharedToken(specialToken);

      const result = getSharedToken();
      expect(result?.token).toBe(specialToken);
    });

    it("should handle rapid successive writes", () => {
      for (let i = 0; i < 100; i++) {
        setSharedToken(`token-${i}`);
      }

      const result = getSharedToken();
      expect(result?.token).toBe("token-99");
    });
  });

  describe("getFreshSharedTokenWithFallback", () => {
    it("should return fresh token without calling fallback", async () => {
      const tokenData: SharedToken = {
        token: "fresh-token",
        refreshedAt: Date.now() - 1000,
      };
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify(tokenData);

      const fallback = jest.fn<() => Promise<string | null>>().mockResolvedValue("fallback-token");

      const result = await getFreshSharedTokenWithFallback(fallback);

      expect(result).toBe("fresh-token");
      expect(fallback).not.toHaveBeenCalled();
    });

    it("should call fallback when no fresh token exists", async () => {
      const fallback = jest.fn<() => Promise<string | null>>().mockResolvedValue("new-token");

      const result = await getFreshSharedTokenWithFallback(fallback);

      expect(result).toBe("new-token");
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it("should store fallback token for other tabs", async () => {
      const fallback = jest.fn<() => Promise<string | null>>().mockResolvedValue("shared-new-token");

      await getFreshSharedTokenWithFallback(fallback);

      const stored = getSharedToken();
      expect(stored?.token).toBe("shared-new-token");
    });

    it("should return null when fallback returns null", async () => {
      const fallback = jest.fn<() => Promise<string | null>>().mockResolvedValue(null);

      const result = await getFreshSharedTokenWithFallback(fallback);

      expect(result).toBeNull();
    });

    it("should return null when fallback returns undefined", async () => {
      const fallback = jest.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined);

      const result = await getFreshSharedTokenWithFallback(fallback);

      expect(result).toBeNull();
    });

    it("should not store token when fallback returns null", async () => {
      const fallback = jest.fn<() => Promise<string | null>>().mockResolvedValue(null);

      await getFreshSharedTokenWithFallback(fallback);

      expect(mockStorage[SHARED_TOKEN_KEY]).toBeUndefined();
    });

    it("should call fallback when token is expired", async () => {
      const expiredData: SharedToken = {
        token: "expired-token",
        refreshedAt: Date.now() - TOKEN_FRESHNESS_MS - 1000,
      };
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify(expiredData);

      const fallback = jest.fn<() => Promise<string | null>>().mockResolvedValue("refreshed-token");

      const result = await getFreshSharedTokenWithFallback(fallback);

      expect(result).toBe("refreshed-token");
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it("should overwrite expired token with new one", async () => {
      const expiredData: SharedToken = {
        token: "expired-token",
        refreshedAt: Date.now() - TOKEN_FRESHNESS_MS - 1000,
      };
      mockStorage[SHARED_TOKEN_KEY] = JSON.stringify(expiredData);

      const fallback = jest.fn<() => Promise<string | null>>().mockResolvedValue("new-token");

      await getFreshSharedTokenWithFallback(fallback);

      const stored = getSharedToken();
      expect(stored?.token).toBe("new-token");
    });
  });
});
