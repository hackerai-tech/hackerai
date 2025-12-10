import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { renderHook, act } from "@testing-library/react";
import { useAuthFromAuthKit, AuthKitDeps } from "../use-auth-from-authkit";
import { CrossTabMutex } from "../cross-tab-mutex";
import * as sharedToken from "../shared-token";

describe("useAuthFromAuthKit", () => {
  let mockStorage: Record<string, string>;
  let mockGetAccessToken: jest.Mock<() => Promise<string | undefined>>;
  let mockRefresh: jest.Mock<() => Promise<string | undefined>>;
  let mockMutex: CrossTabMutex;
  let mockDeps: AuthKitDeps;

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

    mockGetAccessToken = jest.fn<() => Promise<string | undefined>>();
    mockRefresh = jest.fn<() => Promise<string | undefined>>();
    mockMutex = new CrossTabMutex({
      lockKey: "test-token-refresh",
      lockTimeoutMs: 15000,
    });

    mockDeps = {
      useAuth: () => ({ user: { id: "user-123" }, loading: false }),
      useAccessToken: () => ({
        getAccessToken: mockGetAccessToken,
        accessToken: "current-token",
        refresh: mockRefresh,
      }),
      mutex: mockMutex,
      isCrossTabEnabled: () => true, // Enable feature flag by default in tests
    };

    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("basic auth state", () => {
    it("should return isAuthenticated true when user exists", () => {
      mockDeps.useAuth = () => ({ user: { id: "user-123" }, loading: false });

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      expect(result.current.isAuthenticated).toBe(true);
    });

    it("should return isAuthenticated false when no user", () => {
      mockDeps.useAuth = () => ({ user: null, loading: false });

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      expect(result.current.isAuthenticated).toBe(false);
    });

    it("should return isLoading from useAuth", () => {
      mockDeps.useAuth = () => ({ user: null, loading: true });

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      expect(result.current.isLoading).toBe(true);
    });
  });

  describe("fetchAccessToken without forceRefresh", () => {
    it("should return null when no user", async () => {
      mockDeps.useAuth = () => ({ user: null, loading: false });

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken();

      expect(token).toBeNull();
      expect(mockGetAccessToken).not.toHaveBeenCalled();
    });

    it("should call getAccessToken when user exists", async () => {
      mockGetAccessToken.mockResolvedValue("access-token-123");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken();

      expect(token).toBe("access-token-123");
      expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
    });

    it("should return null when getAccessToken returns undefined", async () => {
      mockGetAccessToken.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken();

      expect(token).toBeNull();
    });
  });

  describe("fetchAccessToken with forceRefresh - path 1: pre-lock fresh shared token check", () => {
    it("should return fresh shared token without calling refresh or getAccessToken", async () => {
      const freshTokenData = {
        token: "fresh-shared-token",
        refreshedAt: Date.now() - 1000,
      };
      mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify(freshTokenData);

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      expect(token).toBe("fresh-shared-token");
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockGetAccessToken).not.toHaveBeenCalled();
    });

    it("should not overwrite existing fresh token", async () => {
      const originalTimestamp = Date.now() - 1000;
      const freshTokenData = {
        token: "fresh-shared-token",
        refreshedAt: originalTimestamp,
      };
      mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify(freshTokenData);

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      await result.current.fetchAccessToken({ forceRefreshToken: true });

      // Token should remain unchanged
      const stored = JSON.parse(mockStorage[sharedToken.SHARED_TOKEN_KEY]);
      expect(stored.token).toBe("fresh-shared-token");
      expect(stored.refreshedAt).toBe(originalTimestamp);
    });

    it("should proceed to acquire lock when no fresh shared token exists", async () => {
      // No shared token in storage
      mockRefresh.mockResolvedValue("refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      // Should have called refresh (via lock acquisition path)
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(token).toBe("refreshed-token");
    });

    it("should proceed to acquire lock when shared token is expired", async () => {
      // Expired shared token
      mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
        token: "expired-token",
        refreshedAt: Date.now() - sharedToken.TOKEN_FRESHNESS_MS - 1000,
      });
      mockRefresh.mockResolvedValue("new-refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      // Should have called refresh since token was expired
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(token).toBe("new-refreshed-token");
    });
  });

  describe("fetchAccessToken with forceRefresh - path 2: post-lock fresh shared token check", () => {
    it("should call refresh when no fresh shared token and lock acquired", async () => {
      mockRefresh.mockResolvedValue("refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      expect(token).toBe("refreshed-token");
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it("should store refreshed token in shared storage for other tabs", async () => {
      mockRefresh.mockResolvedValue("new-refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      await result.current.fetchAccessToken({ forceRefreshToken: true });

      const stored = JSON.parse(mockStorage[sharedToken.SHARED_TOKEN_KEY]);
      expect(stored.token).toBe("new-refreshed-token");
      expect(stored.refreshedAt).toBeDefined();
    });

    it("should use fresh shared token if another tab refreshed while waiting for lock (double-check)", async () => {
      // Another tab holds the lock
      const otherMutex = new CrossTabMutex({ lockKey: "test-token-refresh" });
      otherMutex.tryAcquire();

      mockGetAccessToken.mockResolvedValue("fallback-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const tokenPromise = result.current.fetchAccessToken({ forceRefreshToken: true });

      // Simulate other tab refreshing and releasing lock
      await act(async () => {
        jest.advanceTimersByTime(100);
        mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
          token: "other-tab-token",
          refreshedAt: Date.now(),
        });
        otherMutex.release();
        jest.advanceTimersByTime(100);
      });

      const token = await tokenPromise;

      // Should use the fresh shared token from the other tab (double-check inside lock)
      expect(token).toBe("other-tab-token");
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it("should not call refresh when fresh shared token found during double-check", async () => {
      // Another tab holds the lock
      const otherMutex = new CrossTabMutex({ lockKey: "test-token-refresh" });
      otherMutex.tryAcquire();

      mockRefresh.mockResolvedValue("our-refresh-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const tokenPromise = result.current.fetchAccessToken({ forceRefreshToken: true });

      // Simulate other tab refreshing and releasing lock
      await act(async () => {
        jest.advanceTimersByTime(100);
        mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
          token: "other-tab-token",
          refreshedAt: Date.now(),
        });
        otherMutex.release();
        jest.advanceTimersByTime(100);
      });

      const token = await tokenPromise;

      // Should use the fresh token from other tab
      expect(token).toBe("other-tab-token");
      // refresh() should NOT have been called since fresh token was found
      expect(mockRefresh).not.toHaveBeenCalled();
      // Token in storage should still be from other tab (value preserved)
      const stored = JSON.parse(mockStorage[sharedToken.SHARED_TOKEN_KEY]);
      expect(stored.token).toBe("other-tab-token");
    });
  });

  describe("fetchAccessToken with forceRefresh - path 3: lock timeout fresh shared token check", () => {
    it("should fall back to getAccessToken when lock times out and no fresh shared token", async () => {
      // Another tab holds the lock indefinitely
      mockStorage["test-token-refresh"] = JSON.stringify({
        tabId: "other-tab-id",
        timestamp: Date.now(),
      });

      mockGetAccessToken.mockResolvedValue("fallback-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const tokenPromise = result.current.fetchAccessToken({ forceRefreshToken: true });

      // Advance time past lock timeout
      await act(async () => {
        jest.advanceTimersByTime(16000);
      });

      const token = await tokenPromise;

      expect(token).toBe("fallback-token");
      expect(mockGetAccessToken).toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it("should store getAccessToken result in shared storage on timeout fallback", async () => {
      // Another tab holds the lock indefinitely
      mockStorage["test-token-refresh"] = JSON.stringify({
        tabId: "other-tab-id",
        timestamp: Date.now(),
      });

      mockGetAccessToken.mockResolvedValue("fallback-token-stored");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const tokenPromise = result.current.fetchAccessToken({ forceRefreshToken: true });

      // Advance time past lock timeout
      await act(async () => {
        jest.advanceTimersByTime(16000);
      });

      await tokenPromise;

      // Fallback token should be stored in shared storage
      const stored = JSON.parse(mockStorage[sharedToken.SHARED_TOKEN_KEY]);
      expect(stored.token).toBe("fallback-token-stored");
      expect(stored.refreshedAt).toBeDefined();
    });

    it("should use fresh shared token on timeout if another tab refreshed", async () => {
      // Another tab holds the lock
      mockStorage["test-token-refresh"] = JSON.stringify({
        tabId: "other-tab-id",
        timestamp: Date.now(),
      });

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const tokenPromise = result.current.fetchAccessToken({ forceRefreshToken: true });

      // Advance time, then simulate other tab storing token before timeout
      await act(async () => {
        jest.advanceTimersByTime(14000);
        mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
          token: "other-tab-refreshed-token",
          refreshedAt: Date.now(),
        });
        // Lock times out
        jest.advanceTimersByTime(2000);
      });

      const token = await tokenPromise;

      expect(token).toBe("other-tab-refreshed-token");
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockGetAccessToken).not.toHaveBeenCalled();
    });

    it("should not call getAccessToken when fresh shared token found on timeout", async () => {
      // Another tab holds the lock
      mockStorage["test-token-refresh"] = JSON.stringify({
        tabId: "other-tab-id",
        timestamp: Date.now(),
      });

      mockGetAccessToken.mockResolvedValue("our-fallback-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const tokenPromise = result.current.fetchAccessToken({ forceRefreshToken: true });

      // Simulate other tab storing token before our timeout
      await act(async () => {
        jest.advanceTimersByTime(14000);
        mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
          token: "other-tab-token",
          refreshedAt: Date.now(),
        });
        jest.advanceTimersByTime(2000);
      });

      const token = await tokenPromise;

      // Should use the fresh token from other tab
      expect(token).toBe("other-tab-token");
      // getAccessToken should NOT have been called since fresh token was found
      expect(mockGetAccessToken).not.toHaveBeenCalled();
      // Token in storage should still be from other tab (value preserved)
      const stored = JSON.parse(mockStorage[sharedToken.SHARED_TOKEN_KEY]);
      expect(stored.token).toBe("other-tab-token");
    });
  });

  describe("fetchAccessToken error handling", () => {
    it("should return cached token on network error", async () => {
      mockDeps.useAccessToken = () => ({
        getAccessToken: mockGetAccessToken,
        accessToken: "cached-token-value",
        refresh: mockRefresh,
      });

      mockGetAccessToken.mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      // Let the ref update
      await act(async () => {
        jest.advanceTimersByTime(0);
      });

      const token = await result.current.fetchAccessToken();

      expect(token).toBe("cached-token-value");
    });

    it("should return null on error when no cached token", async () => {
      mockDeps.useAccessToken = () => ({
        getAccessToken: mockGetAccessToken,
        accessToken: undefined,
        refresh: mockRefresh,
      });

      mockGetAccessToken.mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken();

      expect(token).toBeNull();
    });
  });

  describe("useSharedTokenCleanup", () => {
    it("should set up interval to clear expired tokens when feature enabled", () => {
      // Set an expired token
      mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
        token: "expired-token",
        refreshedAt: Date.now() - sharedToken.TOKEN_FRESHNESS_MS - 1000,
      });

      renderHook(() => useAuthFromAuthKit(mockDeps));

      // Token should still exist before interval fires
      expect(mockStorage[sharedToken.SHARED_TOKEN_KEY]).toBeDefined();

      act(() => {
        jest.advanceTimersByTime(sharedToken.TOKEN_FRESHNESS_MS);
      });

      // Token should be cleared by the interval
      expect(mockStorage[sharedToken.SHARED_TOKEN_KEY]).toBeUndefined();
    });

    it("should clear interval on unmount", () => {
      // Set an expired token
      mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
        token: "expired-token",
        refreshedAt: Date.now() - sharedToken.TOKEN_FRESHNESS_MS - 1000,
      });

      const { unmount } = renderHook(() => useAuthFromAuthKit(mockDeps));

      unmount();

      act(() => {
        jest.advanceTimersByTime(sharedToken.TOKEN_FRESHNESS_MS * 3);
      });

      // Token should still exist because interval was cleared
      expect(mockStorage[sharedToken.SHARED_TOKEN_KEY]).toBeDefined();
    });

    it("should NOT set up interval when feature disabled", () => {
      mockDeps.isCrossTabEnabled = () => false;

      // Set an expired token
      mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
        token: "expired-token",
        refreshedAt: Date.now() - sharedToken.TOKEN_FRESHNESS_MS - 1000,
      });

      renderHook(() => useAuthFromAuthKit(mockDeps));

      act(() => {
        jest.advanceTimersByTime(sharedToken.TOKEN_FRESHNESS_MS * 3);
      });

      // Token should still exist because cleanup is disabled
      expect(mockStorage[sharedToken.SHARED_TOKEN_KEY]).toBeDefined();
    });
  });

  describe("feature flag - legacy behavior when disabled", () => {
    beforeEach(() => {
      mockDeps.isCrossTabEnabled = () => false;
    });

    it("should use direct refresh without cross-tab coordination", async () => {
      mockRefresh.mockResolvedValue("direct-refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      expect(token).toBe("direct-refreshed-token");
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it("should NOT check shared token storage", async () => {
      // Put a fresh token in storage
      mockStorage[sharedToken.SHARED_TOKEN_KEY] = JSON.stringify({
        token: "shared-token-should-be-ignored",
        refreshedAt: Date.now() - 1000,
      });

      mockRefresh.mockResolvedValue("direct-refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      // Should call refresh directly, ignoring the shared token
      expect(token).toBe("direct-refreshed-token");
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it("should NOT store refreshed token in shared storage", async () => {
      mockRefresh.mockResolvedValue("direct-refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      await result.current.fetchAccessToken({ forceRefreshToken: true });

      // Shared storage should remain empty
      expect(mockStorage[sharedToken.SHARED_TOKEN_KEY]).toBeUndefined();
    });

    it("should NOT use mutex for coordination", async () => {
      // Another tab holds the lock
      mockStorage["test-token-refresh"] = JSON.stringify({
        tabId: "other-tab-id",
        timestamp: Date.now(),
      });

      mockRefresh.mockResolvedValue("direct-refreshed-token");

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      // Should return immediately without waiting for lock
      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      expect(token).toBe("direct-refreshed-token");
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it("should return null when refresh returns undefined", async () => {
      mockRefresh.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuthFromAuthKit(mockDeps));

      const token = await result.current.fetchAccessToken({ forceRefreshToken: true });

      expect(token).toBeNull();
    });
  });
});
