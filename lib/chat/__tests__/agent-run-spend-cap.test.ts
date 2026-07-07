import { describe, expect, it } from "@jest/globals";
import {
  canContinueProAgentRunWithPremium,
  resolveAgentRunSpendCapContinuationModel,
} from "../agent-run-spend-cap";
import type { ExtraUsageConfig } from "@/types";

describe("canContinueProAgentRunWithPremium", () => {
  it("allows premium continuation with extra usage balance", () => {
    expect(
      canContinueProAgentRunWithPremium({
        enabled: true,
        hasBalance: true,
        balanceDollars: 2,
        autoReloadEnabled: false,
      }),
    ).toBe(true);
  });

  it("allows premium continuation with auto-reload", () => {
    expect(
      canContinueProAgentRunWithPremium({
        enabled: true,
        hasBalance: false,
        balanceDollars: 0,
        autoReloadEnabled: true,
      }),
    ).toBe(true);
  });

  it("blocks premium continuation when extra usage is unavailable", () => {
    expect(canContinueProAgentRunWithPremium(undefined)).toBe(false);
    expect(
      canContinueProAgentRunWithPremium({
        enabled: false,
        hasBalance: true,
        balanceDollars: 2,
        autoReloadEnabled: true,
      }),
    ).toBe(false);
  });

  it("blocks premium continuation when the extra-usage monthly cap is exhausted", () => {
    const config: ExtraUsageConfig = {
      enabled: true,
      hasBalance: true,
      balanceDollars: 2,
      autoReloadEnabled: false,
      monthlyRemainingDollars: 0,
    };

    expect(canContinueProAgentRunWithPremium(config)).toBe(false);
  });
});

describe("resolveAgentRunSpendCapContinuationModel", () => {
  it("preserves non-Max Pro Agent spend-cap continuations", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "hackerai-pro",
        extraUsageConfig: undefined,
      }),
    ).toBe("hackerai-pro");

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "auto",
        extraUsageConfig: undefined,
      }),
    ).toBe("auto");

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: undefined,
        extraUsageConfig: undefined,
      }),
    ).toBeUndefined();

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: false,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "hackerai-pro",
        extraUsageConfig: undefined,
      }),
    ).toBe("hackerai-pro");

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: undefined,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "hackerai-max",
        extraUsageConfig: undefined,
      }),
    ).toBe("hackerai-pro");
  });

  it("keeps Max for Ultra continuations", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "ultra",
        selectedModelOverride: "hackerai-max",
        extraUsageConfig: {
          enabled: true,
          hasBalance: false,
          balanceDollars: 0,
          autoReloadEnabled: true,
        },
      }),
    ).toBe("hackerai-max");
  });

  it("keeps Max outside Ultra when extra usage is available", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "hackerai-max",
        extraUsageConfig: {
          enabled: true,
          hasBalance: true,
          balanceDollars: 10,
          autoReloadEnabled: false,
        },
      }),
    ).toBe("hackerai-max");
  });

  it("downgrades Max outside Ultra when extra usage is unavailable", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "hackerai-max",
        extraUsageConfig: {
          enabled: true,
          hasBalance: true,
          balanceDollars: 10,
          autoReloadEnabled: false,
          monthlyRemainingDollars: 0,
        },
      }),
    ).toBe("hackerai-pro");
  });

  it("leaves Standard and non-spend-cap requests unchanged", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "hackerai-standard",
        extraUsageConfig: undefined,
      }),
    ).toBe("hackerai-standard");

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "tool-calls",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "hackerai-pro",
        extraUsageConfig: undefined,
      }),
    ).toBe("hackerai-pro");
  });
});
