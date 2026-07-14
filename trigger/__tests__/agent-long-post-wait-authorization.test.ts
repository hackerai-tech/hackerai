import fs from "node:fs";
import path from "node:path";

const taskSource = fs.readFileSync(
  path.resolve(__dirname, "../agent-long.ts"),
  "utf8",
);

describe("agent-long post-wait authorization contract", () => {
  it("fails closed when an ask-approval payload uses another protocol", () => {
    expect(taskSource).toMatch(
      /agentPermissionMode === "ask_approval"[\s\S]*approvalProtocolVersion !==[\s\S]*AGENT_TOOL_APPROVAL_PROTOCOL_VERSION[\s\S]*unsupported protocol version/,
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
      "return { approved: true, approvalId }",
      deriveGrant,
    );

    expect(approvedBranch).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(approvedBranch);
    expect(deriveGrant).toBeGreaterThan(revalidate);
    expect(approvedReturn).toBeGreaterThan(deriveGrant);
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
      /onPostWaitAuthorizationDenied: \(\) => userStopSignal\.abort\(\)/,
    );
  });
});
