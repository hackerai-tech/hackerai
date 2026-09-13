import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  CHECKOUT_NAVIGATION_GUARD_WINDOW_MS,
  getRecentCheckoutNavigation,
  rememberCheckoutNavigation,
} from "../checkout-navigation-guard";

describe("checkout navigation guard", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns a matching recent navigation", () => {
    rememberCheckoutNavigation({
      attemptId: "ca_recent_123",
      plan: "pro-monthly-plan",
      startedAt: 10_000,
    });

    expect(
      getRecentCheckoutNavigation({
        plan: "pro-monthly-plan",
        now: 10_000 + CHECKOUT_NAVIGATION_GUARD_WINDOW_MS,
      }),
    ).toEqual({
      attemptId: "ca_recent_123",
      plan: "pro-monthly-plan",
      startedAt: 10_000,
    });
  });

  it("expires old, future, and mismatched records", () => {
    rememberCheckoutNavigation({
      attemptId: "ca_old_123",
      plan: "pro-monthly-plan",
      startedAt: 10_000,
    });
    expect(
      getRecentCheckoutNavigation({
        plan: "pro-monthly-plan",
        now: 10_001 + CHECKOUT_NAVIGATION_GUARD_WINDOW_MS,
      }),
    ).toBeNull();

    rememberCheckoutNavigation({
      attemptId: "ca_other_123",
      plan: "ultra-monthly-plan",
      startedAt: 20_000,
    });
    expect(
      getRecentCheckoutNavigation({
        plan: "pro-monthly-plan",
        now: 20_000,
      }),
    ).toBeNull();

    rememberCheckoutNavigation({
      attemptId: "ca_future_123",
      plan: "pro-monthly-plan",
      startedAt: 30_001,
    });
    expect(
      getRecentCheckoutNavigation({
        plan: "pro-monthly-plan",
        now: 30_000,
      }),
    ).toBeNull();
  });

  it("falls back when session storage is unavailable", () => {
    const storageSpy = jest
      .spyOn(window, "sessionStorage", "get")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    try {
      expect(
        getRecentCheckoutNavigation({ plan: "pro-monthly-plan" }),
      ).toBeNull();
      expect(() =>
        rememberCheckoutNavigation({
          attemptId: "ca_blocked_123",
          plan: "pro-monthly-plan",
          startedAt: 10_000,
        }),
      ).not.toThrow();
    } finally {
      storageSpy.mockRestore();
    }
  });
});
