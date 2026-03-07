/**
 * Tests for extra-usage utility functions.
 *
 * Pure function tests run directly. Async functions use jest.isolateModules()
 * for fresh module instances with mocked Convex dependencies.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("extra-usage", () => {
  // ==========================================================================
  // EXTRA_USAGE_MULTIPLIER constant
  // ==========================================================================
  describe("EXTRA_USAGE_MULTIPLIER", () => {
    const { EXTRA_USAGE_MULTIPLIER } =
      require("../extra-usage") as typeof import("../extra-usage");

    it("should be 1.1 (10% markup)", () => {
      expect(EXTRA_USAGE_MULTIPLIER).toBe(1.1);
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
          enabled: true,
          autoReloadEnabled: true,
          autoReloadThresholdDollars: 5,
          autoReloadAmountDollars: 20,
        });

        const result = await getExtraUsageBalance("user-123");

        expect(result).toEqual({
          balanceDollars: 10.5,
          enabled: true,
          autoReloadEnabled: true,
          autoReloadThresholdDollars: 5,
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
      it("should return no-op result when amount <= 0", async () => {
        const { refundToBalance } = getIsolatedModule();

        const result = await refundToBalance("user-123", 0);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 0,
          noOp: true,
        });
        expect(mockMutation).not.toHaveBeenCalled();
      });

      it("should return no-op result for negative amount", async () => {
        const { refundToBalance } = getIsolatedModule();

        const result = await refundToBalance("user-123", -1.0);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 0,
          noOp: true,
        });
        expect(mockMutation).not.toHaveBeenCalled();
      });

      it("should call Convex mutation for positive dollar amount", async () => {
        const { refundToBalance } = getIsolatedModule();

        mockMutation.mockResolvedValue({
          success: true,
          newBalanceDollars: 15.5,
        });

        const result = await refundToBalance("user-123", 0.5);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 15.5,
        });
        expect(mockMutation).toHaveBeenCalled();
      });

      it("should return failure result on Convex error", async () => {
        const { refundToBalance } = getIsolatedModule();

        mockMutation.mockRejectedValue(new Error("Convex error"));

        const result = await refundToBalance("user-123", 0.5);

        expect(result).toEqual({
          success: false,
          newBalanceDollars: 0,
        });
      });
    });

    describe("deductFromBalance", () => {
      it("should return no-op result when amount <= 0", async () => {
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

      it("should return no-op result for negative amount", async () => {
        const { deductFromBalance } = getIsolatedModule();

        const result = await deductFromBalance("user-123", -1.0);

        expect(result).toEqual({
          success: true,
          newBalanceDollars: 0,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          noOp: true,
        });
        expect(mockAction).not.toHaveBeenCalled();
      });

      it("should call Convex action for positive dollar amount", async () => {
        const { deductFromBalance } = getIsolatedModule();

        mockAction.mockResolvedValue({
          success: true,
          newBalanceDollars: 8.5,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          autoReloadTriggered: false,
        });

        const result = await deductFromBalance("user-123", 0.2);

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

        const result = await deductFromBalance("user-123", 0.5);

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

        const result = await deductFromBalance("user-123", 10.0);

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

        const result = await deductFromBalance("user-123", 1.0);

        expect(result.success).toBe(false);
        expect(result.monthlyCapExceeded).toBe(true);
      });

      it("should return failure result on Convex error", async () => {
        const { deductFromBalance } = getIsolatedModule();

        mockAction.mockRejectedValue(new Error("Convex error"));

        const result = await deductFromBalance("user-123", 0.5);

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
