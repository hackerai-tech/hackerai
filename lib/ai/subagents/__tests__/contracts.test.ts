import { describe, expect, it } from "@jest/globals";

import {
  agentValidationResultSchema,
  createAgentInputSchema,
  securityValidationResultSchema,
  sendMessageToAgentInputSchema,
  waitForAgentsInputSchema,
} from "../contracts";

describe("subagent contracts", () => {
  it("matches the create_agent parameter contract", () => {
    expect(
      createAgentInputSchema.parse({
        name: "Stored XSS validator",
        task: "Validate stored XSS on the profile page.",
      }),
    ).toEqual({
      name: "Stored XSS validator",
      task: "Validate stored XSS on the profile page.",
      inherit_context: true,
      skills: null,
    });
    expect(() =>
      createAgentInputSchema.parse({
        name: "Validator",
        task: "Validate",
        profile: "security_validation",
      }),
    ).toThrow();
  });

  it("matches the send_message_to_agent and wait_for_agents contracts", () => {
    expect(
      sendMessageToAgentInputSchema.parse({
        target_agent_id: "sa_123",
        message: "Use the newly captured response as evidence.",
      }),
    ).toEqual({
      target_agent_id: "sa_123",
      message: "Use the newly captured response as evidence.",
      message_type: "information",
      priority: "normal",
    });
    expect(waitForAgentsInputSchema.parse({})).toEqual({
      reason: "Waiting for messages from other agents",
      timeout_seconds: 300,
    });
    expect(() =>
      waitForAgentsInputSchema.parse({ timeout_seconds: 301 }),
    ).toThrow();
  });

  it("requires evidence for confirmed verdicts", () => {
    expect(() =>
      securityValidationResultSchema.parse({
        verdict: "confirmed",
        confidence: "high",
        summary: "Confirmed",
        reproduction_steps: [],
        evidence_refs: [],
        limitations: [],
        recommended_severity: "high",
      }),
    ).toThrow(/requires at least one reproduction step/i);
  });

  it("keeps Trigger and failure internals out of the parent validation result", () => {
    const result = agentValidationResultSchema.parse({
      trigger_run_id: "run_internal",
      failure_code: "internal_failure",
      status: "completed",
      verdict: "confirmed",
      confidence: "high",
      summary: "Confirmed independently.",
      reproduction_steps: ["Reproduce the issue"],
      evidence_refs: ["artifact:proof"],
      limitations: [],
      recommended_severity: "high",
    });

    expect(result).not.toHaveProperty("trigger_run_id");
    expect(result).not.toHaveProperty("failure_code");
  });
});
