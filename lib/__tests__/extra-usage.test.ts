/**
 * Tests for extra-usage utility functions.
 *
 * Pure function tests run directly. Async functions use jest.isolateModules()
 * for fresh module instances with mocked Convex dependencies.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("extra-usage", () => {
  // ==========================================================================
  // pointsToDollars - Pure function
  // ==========================================================================
  describe("pointsToDollars", () => {
    // Import directly for pure function tests
    const { pointsToDollars, EXTRA_USAGE_MULTIPLIER } =
      require("../extra-usage") as typeof import("../extra-usage");

    it("should convert points to dollars with 1.1x multiplier", () => {
      // 10000 points = $1.00 base, * 1.1 = $1.10 (floating point: $1.11)
      expect(pointsToDollars(10000)).toBe(1.11);
    });

    it("should round up to nearest cent", () => {
      // 1 point = $0.0001 base, * 1.1 = $0.00011 → rounds up to $0.01
      expect(pointsToDollars(1)).toBe(0.01);
      // 100 points = $0.01 base, * 1.1 = $0.011 → rounds up to $0.02
      expect(pointsToDollars(100)).toBe(0.02);
    });

    it("should return 0 for 0 points", () => {
      expect(pointsToDollars(0)).toBe(0);
    });

    it("should handle large point values", () => {
      // 1M points = $100 base, * 1.1 = $110 (floating point: $110.01)
      expect(pointsToDollars(1_000_000)).toBe(110.01);
    });

    it("should apply EXTRA_USAGE_MULTIPLIER correctly", () => {
      expect(EXTRA_USAGE_MULTIPLIER).toBe(1.1);
      // 50000 points = $5.00 base, * 1.1 = $5.50
      expect(pointsToDollars(50000)).toBe(5.5);
    });
  });

  // ==========================================================================
  // Async functions with mocked Convex
  // ==========================================================================
  describe("async functions", () => {
    const mockQuery = jest.fn();
    const mockMutation = jest.fn();
    const mockAction = jest.fn();

    beforeEach(() => {
      jest.resetModules();
      jest.clearAllMocks();
    });

    const getIsolatedModule = () => {
      let isolatedModule: typeof import("../extra-usage");

      jest.isolateModules(() => {
        jest.doMock("convex/browser", () => ({
          ConvexHttpClient: jest.fn().mockImplementation(() => ({
            query: mockQuery,
            mutation: mockMutation,
            action: mockAction,
          })),
        }));

        isolatedModule = require("../extra-usage");
      });

      return isolatedModule!;
    };

    describe("getExtraUsageBalance", () => {
      it("should return balance info on success", async () => {
        const { getExtraUsageBalance } = getIsolatedModule();

        mockQuery.mockResolvedValue({
          balanceDollars: 10.5,
          balancePoints: 100000,
          enabled: true,
          autoReloadEnabled: true,
          autoReloadThresholdDollars: 5,
          autoReloadThresholdPoints: 50000,
          autoReloadAmountDollars: 20,
        });

        const result = await getExtraUsageBalance("user-123");

        expect(result).toEqual({
          balanceDollars: 10.5,
          balancePoints: 100000,
          enabled: true,
          autoReloadEnabled: true,
          autoReloadThresholdDollars: 5,
          autoReloadThresholdPoints: 50000,
          autoReloadAmountDollars: 20,
        });
        expect(mockQuery).toHaveBeenCalled();
      });

      it("should return null on Convex error", async () => {
        const { getExtraUsageBalance } = getIsolatedModule();

        mockQuery.mockRejectedValue(new Error("Convex error"));

        const result = await getExtraUsageBalance("user-123");

        expect(result).toBeNull();
      });
    });

    describe("refundToBalance", () => {
      it("should return no-op result when pointsToRefund <= 0", async () => {
        const { refundToBalance } = getIsolatedModule();

        const result = await refundToBalance("user-123", 0);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 0,
          noOp: true,
        });
        expect(mockMutation).not.toHaveBeenCalled();
      });

      it("should return no-op result for negative points", async () => {
        const { refundToBalance } = getIsolatedModule();

        const result = await refundToBalance("user-123", -100);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 0,
          noOp: true,
        });
        expect(mockMutation).not.toHaveBeenCalled();
      });

      it("should call Convex mutation for positive points", async () => {
        const { refundToBalance } = getIsolatedModule();

        mockMutation.mockResolvedValue({
          success: true,
          newBalanceDollars: 15.5,
        });

        const result = await refundToBalance("user-123", 5000);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 15.5,
        });
        expect(mockMutation).toHaveBeenCalled();
      });

      it("should return failure result on Convex error", async () => {
        const { refundToBalance } = getIsolatedModule();

        mockMutation.mockRejectedValue(new Error("Convex error"));

        const result = await refundToBalance("user-123", 5000);

        expect(result).toEqual({
          success: false,
          newBalanceDollars: 0,
        });
      });
    });

    describe("deductFromBalance", () => {
      it("should return no-op result when pointsUsed <= 0", async () => {
        const { deductFromBalance } = getIsolatedModule();

        const result = await deductFromBalance("user-123", 0);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 0,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          noOp: true,
        });
        expect(mockAction).not.toHaveBeenCalled();
      });

      it("should return no-op result for negative points", async () => {
        const { deductFromBalance } = getIsolatedModule();

        const result = await deductFromBalance("user-123", -100);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 0,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          noOp: true,
        });
        expect(mockAction).not.toHaveBeenCalled();
      });

      it("should call Convex action for positive points", async () => {
        const { deductFromBalance } = getIsolatedModule();

        mockAction.mockResolvedValue({
          success: true,
          newBalanceDollars: 8.5,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          autoReloadTriggered: false,
        });

        const result = await deductFromBalance("user-123", 2000);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 8.5,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          autoReloadTriggered: false,
          autoReloadResult: undefined,
        });
        expect(mockAction).toHaveBeenCalled();
      });

      it("should return auto-reload info when triggered", async () => {
        const { deductFromBalance } = getIsolatedModule();

        mockAction.mockResolvedValue({
          success: true,
          newBalanceDollars: 25.5,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          autoReloadTriggered: true,
          autoReloadResult: {
            success: true,
            chargedAmountDollars: 20,
          },
        });

        const result = await deductFromBalance("user-123", 5000);

        expect(result.autoReloadTriggered).toBe(true);
        expect(result.autoReloadResult).toEqual({
          success: true,
          chargedAmountDollars: 20,
        });
      });

      it("should return insufficient funds on Convex response", async () => {
        const { deductFromBalance } = getIsolatedModule();

        mockAction.mockResolvedValue({
          success: false,
          newBalanceDollars: 0,
          insufficientFunds: true,
          monthlyCapExceeded: false,
        });

        const result = await deductFromBalance("user-123", 100000);

        expect(result.success).toBe(false);
        expect(result.insufficientFunds).toBe(true);
      });

      it("should return monthly cap exceeded on Convex response", async () => {
        const { deductFromBalance } = getIsolatedModule();

        mockAction.mockResolvedValue({
          success: false,
          newBalanceDollars: 50,
          insufficientFunds: false,
          monthlyCapExceeded: true,
        });

        const result = await deductFromBalance("user-123", 10000);

        expect(result.success).toBe(false);
        expect(result.monthlyCapExceeded).toBe(true);
      });

      it("should return failure result on Convex error", async () => {
        const { deductFromBalance } = getIsolatedModule();

        mockAction.mockRejectedValue(new Error("Convex error"));

        const result = await deductFromBalance("user-123", 5000);

        expect(result).toEqual({
          success: false,
          newBalanceDollars: 0,
          insufficientFunds: true,
          monthlyCapExceeded: false,
        });
      });
    });
  });
});
