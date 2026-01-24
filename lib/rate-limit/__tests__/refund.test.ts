/**
 * Tests for UsageRefundTracker class.
 *
 * Uses jest.isolateModules() to mock the refundUsage dependency.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { RateLimitInfo } from "@/types";

describe("UsageRefundTracker", () => {
  const mockRefundUsage = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockRefundUsage.mockResolvedValue(undefined);
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../refund");

    jest.isolateModules(() => {
      jest.doMock("../token-bucket", () => ({
        refundUsage: mockRefundUsage,
      }));

      isolatedModule = require("../refund");
    });

    return isolatedModule!;
  };

  describe("setUser", () => {
    it("should store user context", () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.setUser("user-123", "pro");

      // User context is stored internally, verified by refund behavior
      expect(tracker).toBeDefined();
    });
  });

  describe("recordDeductions", () => {
    it("should record points deducted from rate limit info", () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      const rateLimitInfo: RateLimitInfo = {
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        pointsDeducted: 100,
        extraUsagePointsDeducted: 50,
      };

      tracker.recordDeductions(rateLimitInfo);

      expect(tracker.hasDeductions()).toBe(true);
    });

    it("should handle missing deduction fields", () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      const rateLimitInfo: RateLimitInfo = {
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
      };

      tracker.recordDeductions(rateLimitInfo);

      expect(tracker.hasDeductions()).toBe(false);
    });
  });

  describe("hasDeductions", () => {
    it("should return false when no deductions recorded", () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      expect(tracker.hasDeductions()).toBe(false);
    });

    it("should return true when points deducted", () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.recordDeductions({
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        pointsDeducted: 100,
      });

      expect(tracker.hasDeductions()).toBe(true);
    });

    it("should return true when extra usage points deducted", () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.recordDeductions({
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        extraUsagePointsDeducted: 50,
      });

      expect(tracker.hasDeductions()).toBe(true);
    });

    it("should return false when both deductions are 0", () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.recordDeductions({
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        pointsDeducted: 0,
        extraUsagePointsDeducted: 0,
      });

      expect(tracker.hasDeductions()).toBe(false);
    });
  });

  describe("refund", () => {
    it("should call refundUsage with recorded deductions", async () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.setUser("user-123", "pro");
      tracker.recordDeductions({
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        pointsDeducted: 100,
        extraUsagePointsDeducted: 50,
      });

      await tracker.refund();

      expect(mockRefundUsage).toHaveBeenCalledWith("user-123", "pro", 100, 50);
    });

    it("should be idempotent - only refund once", async () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.setUser("user-123", "pro");
      tracker.recordDeductions({
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        pointsDeducted: 100,
      });

      await tracker.refund();
      await tracker.refund();
      await tracker.refund();

      expect(mockRefundUsage).toHaveBeenCalledTimes(1);
    });

    it("should not refund if no deductions", async () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.setUser("user-123", "pro");

      await tracker.refund();

      expect(mockRefundUsage).not.toHaveBeenCalled();
    });

    it("should not refund if no user set", async () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      tracker.recordDeductions({
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        pointsDeducted: 100,
      });

      await tracker.refund();

      expect(mockRefundUsage).not.toHaveBeenCalled();
    });

    it("should not mark as refunded on error (allows retry)", async () => {
      const { UsageRefundTracker } = getIsolatedModule();
      const tracker = new UsageRefundTracker();

      mockRefundUsage.mockRejectedValueOnce(new Error("Network error"));
      mockRefundUsage.mockResolvedValueOnce(undefined);

      tracker.setUser("user-123", "pro");
      tracker.recordDeductions({
        remaining: 5000,
        resetTime: new Date(),
        limit: 10000,
        pointsDeducted: 100,
      });

      // First attempt fails
      await tracker.refund();
      expect(mockRefundUsage).toHaveBeenCalledTimes(1);

      // Second attempt succeeds (retry allowed)
      await tracker.refund();
      expect(mockRefundUsage).toHaveBeenCalledTimes(2);

      // Third attempt blocked (already refunded)
      await tracker.refund();
      expect(mockRefundUsage).toHaveBeenCalledTimes(2);
    });
  });
});
