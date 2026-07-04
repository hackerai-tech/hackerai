import { describe, expect, it } from "@jest/globals";
import {
  AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL,
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
  it("forces Pro Agent spend-cap continuations to Standard without extra usage", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "zhacker-pro",
        extraUsageConfig: undefined,
      }),
    ).toBe(AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL);

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "auto",
        extraUsageConfig: undefined,
      }),
    ).toBe(AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL);

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: undefined,
        extraUsageConfig: undefined,
      }),
    ).toBe(AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL);

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: false,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "zhacker-pro",
        extraUsageConfig: undefined,
      }),
    ).toBe(AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL);

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: undefined,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "zhacker-max",
        extraUsageConfig: undefined,
      }),
    ).toBe(AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL);
  });

  it("keeps the premium model when extra usage or auto-reload can cover continuation", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "zhacker-max",
        extraUsageConfig: {
          enabled: true,
          hasBalance: false,
          balanceDollars: 0,
          autoReloadEnabled: true,
        },
      }),
    ).toBe("zhacker-max");
  });

  it("leaves Standard and non-spend-cap requests unchanged", () => {
    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "agent-run-spend-cap",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "zhacker-standard",
        extraUsageConfig: undefined,
      }),
    ).toBe("zhacker-standard");

    expect(
      resolveAgentRunSpendCapContinuationModel({
        finishReason: "tool-calls",
        isAutoContinue: true,
        mode: "agent",
        subscription: "pro",
        selectedModelOverride: "zhacker-pro",
        extraUsageConfig: undefined,
      }),
    ).toBe("zhacker-pro");
  });
});
