import fs from "node:fs";
import path from "node:path";

const taskSource = fs.readFileSync(
  path.resolve(__dirname, "../agent-long.ts"),
  "utf8",
);

describe("agent-long post-wait authorization contract", () => {
  it("fails closed when a gated payload uses another protocol", () => {
    expect(taskSource).toMatch(
      /agentPermissionMode === "ask_approval"[\s\S]*agentPermissionMode === "auto_review"[\s\S]*approvalProtocolVersion !==[\s\S]*AGENT_TOOL_APPROVAL_PROTOCOL_VERSION[\s\S]*unsupported protocol version/,
    );
  });

  it("revalidates every approved resumed operation before deriving grants", () => {
    const approvedBranch = taskSource.indexOf(
      'if (next.output.decision === "approve")',
    );
    const revalidate = taskSource.indexOf(
      "await revalidateAfterSuspend(next.output)",
      approvedBranch,
    );
    const deriveGrant = taskSource.indexOf(
      "deriveApprovedAgentTargetGrant(request, next.output)",
      approvedBranch,
    );
    const approvedReturn = taskSource.indexOf(
      "return { approved: true, approvalId, sandboxIdentity }",
      deriveGrant,
    );

    expect(approvedBranch).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(approvedBranch);
    expect(deriveGrant).toBeGreaterThan(revalidate);
    expect(approvedReturn).toBeGreaterThan(deriveGrant);
  });

  it("carries the checked sandbox identity in every approval success", () => {
    expect(
      taskSource.match(
        /return \{ approved: true, approvalId, sandboxIdentity \};/g,
      ),
    ).toHaveLength(3);
  });

  it("revalidates Auto review approval and sandbox identity without deriving a grant", () => {
    const autoBranch = taskSource.indexOf(
      'if (decision.verdict === "approve")',
    );
    const revalidate = taskSource.indexOf(
      "await revalidateAfterAutoReview",
      autoBranch,
    );
    const sandboxCheck = taskSource.indexOf(
      "await resolveSandboxIdentity()",
      revalidate,
    );
    const approvedReturn = taskSource.indexOf(
      "return { approved: true, approvalId, sandboxIdentity }",
      sandboxCheck,
    );
    const grantDerivation = taskSource.indexOf(
      "deriveApprovedAgentTargetGrant",
      autoBranch,
    );

    expect(autoBranch).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(autoBranch);
    expect(sandboxCheck).toBeGreaterThan(revalidate);
    expect(approvedReturn).toBeGreaterThan(sandboxCheck);
    expect(grantDerivation).toBeGreaterThan(approvedReturn);
  });

  it("excludes separate reviewer latency from active runtime", () => {
    const autoReview = taskSource.indexOf("await reviewAgentToolAction({");
    const pause = taskSource.lastIndexOf(
      "activeRuntimeBudget.pause()",
      autoReview,
    );
    const resume = taskSource.indexOf(
      "activeRuntimeBudget.resume()",
      autoReview,
    );

    expect(autoReview).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(-1);
    expect(pause).toBeLessThan(autoReview);
    expect(resume).toBeGreaterThan(autoReview);
  });

  it("fails closed on denial loops and keeps analytics free of action content", () => {
    expect(taskSource).toMatch(/new AgentAutoReviewDenialTracker\(\)/);
    expect(taskSource).toMatch(/denialTracker\.record\("deny"\)/);
    expect(taskSource).toMatch(/denialTracker\.record\("approve"\)/);
    expect(taskSource).toMatch(/denialTracker\.record\("deny"\)\.tripped/);
    expect(taskSource).toMatch(/onAutoReviewCircuitBreaker\(\)/);
    expect(taskSource).toMatch(/agent_auto_review_circuit_breaker/);
    expect(taskSource).toMatch(
      /Do not retry through a workaround; ask the user/,
    );

    const eventStart = taskSource.indexOf(
      'phLogger.event("agent_auto_review_decision"',
    );
    const eventEnd = taskSource.indexOf("});", eventStart);
    const eventSource = taskSource.slice(eventStart, eventEnd);
    expect(eventSource).not.toMatch(
      /command|target|path|prompt|rationale|credential/,
    );
  });

  it("keeps shadow outcomes private and persists only enforce summaries", () => {
    expect(taskSource).toMatch(
      /autoReview\?\.rolloutPhase === "enforce"[\s\S]*autoReview:/,
    );
  });

  it("excludes suspension time and reacquires free concurrency after checks", () => {
    const beforeSuspend = taskSource.indexOf("await beforeSuspend()");
    const pause = taskSource.indexOf(
      "activeRuntimeBudget.pause()",
      beforeSuspend,
    );
    const wait = taskSource.indexOf("await waitForApprovalInput", pause);
    const resume = taskSource.indexOf("activeRuntimeBudget.resume()", wait);
    const capacity = taskSource.indexOf("await checkRateLimitCapacity(");
    const monthlyCost = taskSource.indexOf(
      "await checkFreeMonthlyCostLimit(freeUsageSubject)",
      capacity,
    );
    const reacquire = taskSource.indexOf(
      "await acquireFreeRunConcurrencyLock(",
      monthlyCost,
    );

    expect(beforeSuspend).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(beforeSuspend);
    expect(wait).toBeGreaterThan(pause);
    expect(resume).toBeGreaterThan(wait);
    expect(taskSource).toMatch(/beforeSuspend:[\s\S]*releaseFreeRunLockOnce/);
    expect(capacity).toBeGreaterThan(-1);
    expect(monthlyCost).toBeGreaterThan(capacity);
    expect(reacquire).toBeGreaterThan(monthlyCost);
  });

  it("checks fresh suspension, ownership, model, and billing state", () => {
    expect(taskSource).toMatch(
      /verifyAgentToolApprovalInputAuthorization\([\s\S]*assertUserCanMakeCostIncurringRequest\(userId\)/,
    );
    expect(taskSource).toMatch(
      /getChatById\(\{ id: chatId \}\)[\s\S]*active_trigger_run_id !== ctx\.run\.id[\s\S]*active_agent_approval_session_id/,
    );
    expect(taskSource).toMatch(
      /buildExtraUsageConfig\([\s\S]*failClosedOnLookupError: true/,
    );
    expect(taskSource).toMatch(
      /normalizeMaxModelForSubscription\([\s\S]*currentlyAllowedModel !== selectedModelOverride/,
    );
    expect(taskSource).toMatch(/await checkRateLimitCapacity\(/);
    expect(taskSource).toMatch(
      /getCurrentAgentEntitlementContext\([\s\S]*currentEntitlement\.subscription !== subscription[\s\S]*currentEntitlement\.organizationId !== organizationId/,
    );
    expect(taskSource).toMatch(
      /onPostWaitAuthorizationDenied: \(\) => userStopSignal\.abort\(\)/,
    );
  });
});
