import { describe, expect, it } from "@jest/globals";
import {
  getAgentFirstDefaultDecision,
  normalizeAgentFirstSandboxType,
  type AgentFirstDefaultEligibility,
  shouldDefaultFreeUserToAgent,
  shouldDefaultUltraUserToAgent,
} from "../agent-first-default";

const baseEligibility: AgentFirstDefaultEligibility = {
  chatMode: "ask",
  defaultLocalSandboxPreference: "desktop",
  hasLocalSandbox: true,
  hasSavedChatMode: false,
  hasUserSelectedModeThisSession: false,
  isCheckingProPlan: false,
  isMobile: false,
  subscription: "free",
  subscriptionResolved: true,
  temporaryChatsEnabled: false,
  userPresent: true,
};

describe("shouldDefaultFreeUserToAgent", () => {
  it("defaults an eligible first-time free desktop user with a local sandbox to Agent", () => {
    expect(shouldDefaultFreeUserToAgent(baseEligibility)).toBe(true);
  });

  it("does not override a saved mode preference", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        hasSavedChatMode: true,
      }),
    ).toBe(false);
  });

  it("does not override a mode selected during the current session", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        hasUserSelectedModeThisSession: true,
      }),
    ).toBe(false);
  });

  it("does not default mobile users to Agent", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        isMobile: true,
      }),
    ).toBe(false);
  });

  it("does not default users without a local sandbox to Agent", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        defaultLocalSandboxPreference: null,
        hasLocalSandbox: false,
      }),
    ).toBe(false);
  });

  it("does not default paid users to Agent through the free-user experiment", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        subscription: "pro",
      }),
    ).toBe(false);
  });

  it("does not default to Agent while subscription status is being checked", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        isCheckingProPlan: true,
      }),
    ).toBe(false);
  });

  it("does not default before subscription status is resolved", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        subscriptionResolved: false,
      }),
    ).toBe(false);
  });

  it("does not default temporary chats to Agent", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        temporaryChatsEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("shouldDefaultUltraUserToAgent", () => {
  const ultraEligibility: AgentFirstDefaultEligibility = {
    ...baseEligibility,
    defaultLocalSandboxPreference: null,
    hasLocalSandbox: false,
    subscription: "ultra",
  };

  it("defaults an eligible first-time Ultra user to Agent without requiring a local sandbox", () => {
    expect(shouldDefaultUltraUserToAgent(ultraEligibility)).toBe(true);
  });

  it("does not override a saved mode preference", () => {
    expect(
      shouldDefaultUltraUserToAgent({
        ...ultraEligibility,
        hasSavedChatMode: true,
      }),
    ).toBe(false);
  });

  it("does not override a mode selected during the current session", () => {
    expect(
      shouldDefaultUltraUserToAgent({
        ...ultraEligibility,
        hasUserSelectedModeThisSession: true,
      }),
    ).toBe(false);
  });

  it("does not default Pro or Pro Plus users through the Ultra default", () => {
    expect(
      shouldDefaultUltraUserToAgent({
        ...ultraEligibility,
        subscription: "pro",
      }),
    ).toBe(false);
    expect(
      shouldDefaultUltraUserToAgent({
        ...ultraEligibility,
        subscription: "pro-plus",
      }),
    ).toBe(false);
  });

  it("does not default temporary chats to Agent", () => {
    expect(
      shouldDefaultUltraUserToAgent({
        ...ultraEligibility,
        temporaryChatsEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("getAgentFirstDefaultDecision", () => {
  it("returns the free-user decision with the local sandbox requirement", () => {
    expect(getAgentFirstDefaultDecision(baseEligibility)).toEqual({
      eligibleSubscriptionTier: "free",
      experimentKey: "free_agent_first_v1",
      selectionReason: "eligible_free_user_local_sandbox",
      useDefaultLocalSandbox: true,
    });
  });

  it("returns the Ultra decision without the local sandbox requirement", () => {
    expect(
      getAgentFirstDefaultDecision({
        ...baseEligibility,
        defaultLocalSandboxPreference: null,
        hasLocalSandbox: false,
        subscription: "ultra",
      }),
    ).toEqual({
      eligibleSubscriptionTier: "ultra",
      experimentKey: "ultra_agent_default_v1",
      selectionReason: "eligible_ultra_user",
      useDefaultLocalSandbox: false,
    });
  });
});

describe("normalizeAgentFirstSandboxType", () => {
  it("returns none when no sandbox preference is available", () => {
    expect(normalizeAgentFirstSandboxType(null)).toBe("none");
  });

  it("preserves known non-identifying sandbox types", () => {
    expect(normalizeAgentFirstSandboxType("desktop")).toBe("desktop");
    expect(normalizeAgentFirstSandboxType("e2b")).toBe("e2b");
  });

  it("buckets remote connection ids without returning the raw id", () => {
    expect(normalizeAgentFirstSandboxType("conn_remote_123")).toBe(
      "remote-connection",
    );
  });
});
