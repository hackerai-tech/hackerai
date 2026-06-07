import { describe, expect, it } from "@jest/globals";
import {
  type AgentFirstDefaultEligibility,
  shouldDefaultFreeUserToAgent,
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

  it("does not default temporary chats to Agent", () => {
    expect(
      shouldDefaultFreeUserToAgent({
        ...baseEligibility,
        temporaryChatsEnabled: true,
      }),
    ).toBe(false);
  });
});
