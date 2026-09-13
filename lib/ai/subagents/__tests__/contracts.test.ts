import { describe, expect, it } from "@jest/globals";

import {
  SUBAGENT_MAX_ACTIVE_SECONDS,
  MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN,
  MAX_SUBAGENTS_PER_PARENT_RUN,
  SUBAGENT_PARENT_SYNTHESIS_RESERVE_DOLLARS,
  SUBAGENT_RESULT_DEADLINE_SECONDS,
  agentValidationResultSchema,
  agentSecurityTaskResultSchema,
  createAgentInputSchema,
  delegateTaskInputSchema,
  continueAgentInputSchema,
  reportToParentInputSchema,
  updateWorkLedgerInputSchema,
  MAX_SECURITY_TASK_COVERAGE_ITEMS,
  securityTaskResultSchema,
  securityValidationResultSchema,
  sendMessageToAgentInputSchema,
  waitForAgentsResultSchema,
  waitForAgentsInputSchema,
} from "../contracts";

describe("subagent contracts", () => {
  it("reserves time to submit a structured result before hard timeout", () => {
    expect(SUBAGENT_RESULT_DEADLINE_SECONDS).toBeLessThan(
      SUBAGENT_MAX_ACTIVE_SECONDS,
    );
  });

  it("allows limited sibling parallelism while reserving parent synthesis", () => {
    expect(MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN).toBe(2);
    expect(MAX_SUBAGENTS_PER_PARENT_RUN).toBe(4);
    expect(SUBAGENT_PARENT_SYNTHESIS_RESERVE_DOLLARS).toBeGreaterThan(0);
  });

  it("matches the create_agent parameter contract", () => {
    expect(
      createAgentInputSchema.parse({
        name: "Stored XSS validator",
        task: "Validate stored XSS on the profile page.",
      }),
    ).toEqual({
      name: "Stored XSS validator",
      task: "Validate stored XSS on the profile page.",
      success_criteria: [],
      inherit_context: true,
      context_refs: null,
      skills: null,
    });
    expect(
      createAgentInputSchema.parse({
        name: "Analyzer",
        task: "Trace authorization checks",
        profile: "security_task",
        success_criteria: ["Identify the enforcing function"],
      }).profile,
    ).toBe("security_task");
  });

  it("keeps profiles out of the generic delegate_task contract", () => {
    expect(
      delegateTaskInputSchema.parse({
        name: "Repository mapper",
        task: "Map the data flow.",
      }),
    ).toMatchObject({
      capabilities: ["code_read"],
      complexity: "medium",
      expected_duration_minutes: 8,
      output_kind: "answer",
    });
    expect(() =>
      delegateTaskInputSchema.parse({
        name: "Validator",
        task: "Validate this.",
        profile: "security_validation",
      }),
    ).toThrow();
    expect(
      continueAgentInputSchema.parse({
        target_agent_id: "sa_123",
        follow_up: "Check the remaining branch.",
      }),
    ).toMatchObject({ target_agent_id: "sa_123" });
  });

  it("bounds typed progress and work-ledger updates", () => {
    expect(
      reportToParentInputSchema.parse({
        event_type: "blocker",
        message: "Need the test URL.",
      }),
    ).toEqual({
      event_type: "blocker",
      message: "Need the test URL.",
      refs: [],
    });
    expect(
      updateWorkLedgerInputSchema.parse({ status: "in_progress" }),
    ).toMatchObject({
      status: "in_progress",
      claims: [],
      assessed_scope: [],
      unassessed_scope: [],
    });
  });

  it("matches the send_message_to_agent and wait_for_agents contracts", () => {
    expect(
      sendMessageToAgentInputSchema.parse({
        target_agent_id: "sa_09041c08",
        message: "Use the newly captured response as evidence.",
      }),
    ).toEqual({
      target_agent_id: "sa_09041c08",
      message: "Use the newly captured response as evidence.",
      message_type: "information",
      priority: "normal",
    });
    expect(waitForAgentsInputSchema.parse({})).toEqual({
      reason: "Waiting for messages from other agents",
      timeout_seconds: 300,
      target_agent_ids: null,
    });
    expect(() =>
      waitForAgentsInputSchema.parse({ timeout_seconds: 301 }),
    ).toThrow();
    expect(
      waitForAgentsResultSchema.parse({
        success: false,
        wait_outcome: "targets_not_found",
        reason: "Wait for the mapper",
        target_agent_ids: ["sa_unknown"],
        active_agents: [],
        error: "Target not found",
      }),
    ).toMatchObject({
      wait_outcome: "targets_not_found",
      target_agent_ids: ["sa_unknown"],
    });
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
      profile: "security_validation",
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

  it("accepts a bounded generic security task result", () => {
    expect(
      agentSecurityTaskResultSchema.parse({
        profile: "security_task",
        status: "completed",
        task_status: "partial",
        summary: "Mapped the authorization path.",
        evidence_refs: ["file:src/auth.ts:42"],
        artifacts: [{ path: "/tmp/auth-map.md" }],
        limitations: ["Dynamic behavior was not exercised."],
        next_steps: ["Run the focused endpoint test."],
        coverage: [
          {
            surface: "API authorization middleware",
            risk_area: "Object-level authorization",
            outcome: "Enforcement was traced to the ownership check.",
            evidence_refs: ["file:src/auth.ts:42"],
          },
        ],
      }),
    ).toMatchObject({
      profile: "security_task",
      task_status: "partial",
      coverage: [
        {
          surface: "API authorization middleware",
          risk_area: "Object-level authorization",
        },
      ],
    });
  });

  it("bounds optional security task coverage", () => {
    expect(() =>
      securityTaskResultSchema.parse({
        task_status: "completed",
        summary: "Reviewed the assigned surfaces.",
        evidence_refs: [],
        artifacts: [],
        limitations: [],
        next_steps: [],
        coverage: Array.from(
          { length: MAX_SECURITY_TASK_COVERAGE_ITEMS + 1 },
          (_, index) => ({
            surface: `Surface ${index}`,
            risk_area: "Authorization",
            outcome: "No issue identified in the reviewed path.",
            evidence_refs: [`file:surface-${index}`],
          }),
        ),
      }),
    ).toThrow();
  });

  it("requires evidence for coverage at both result boundaries", () => {
    const coverage = [
      {
        surface: "API authorization middleware",
        risk_area: "Object-level authorization",
        outcome: "Enforcement was traced to the ownership check.",
        evidence_refs: [],
      },
    ];

    expect(
      securityTaskResultSchema.safeParse({
        task_status: "completed",
        summary: "Reviewed the authorization path.",
        evidence_refs: [],
        artifacts: [],
        limitations: [],
        next_steps: [],
        coverage,
      }).success,
    ).toBe(false);
    expect(
      agentSecurityTaskResultSchema.safeParse({
        profile: "security_task",
        status: "completed",
        task_status: "completed",
        summary: "Reviewed the authorization path.",
        evidence_refs: [],
        artifacts: [],
        limitations: [],
        next_steps: [],
        coverage,
      }).success,
    ).toBe(false);
  });
});
