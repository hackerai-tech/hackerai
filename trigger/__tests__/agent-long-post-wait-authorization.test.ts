import fs from "node:fs";
import path from "node:path";

const taskSource = fs.readFileSync(
  path.resolve(__dirname, "../agent-long.ts"),
  "utf8",
);

const findRequiredSource = (needle: string, fromIndex = 0): number => {
  const index = taskSource.indexOf(needle, fromIndex);
  if (index < 0) {
    throw new Error(`Expected agent-long source marker: ${needle}`);
  }
  return index;
};

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
    ).toHaveLength(2);
    expect(taskSource).toMatch(
      /return \{[\s\S]*?approved: true,[\s\S]*?approvalId,[\s\S]*?sandboxIdentity,[\s\S]*?approvalSource: "auto_review",[\s\S]*?\};/,
    );
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
      'approvalSource: "auto_review"',
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

  it("routes reviewer denials to the human and keeps analytics free of action content", () => {
    expect(taskSource).toMatch(/new AgentAutoReviewDenialTracker\(\)/);
    expect(taskSource).toMatch(/denialTracker\.record\("approve"\)/);
    expect(taskSource).toMatch(/denialTracker\.record\("deny"\)\.tripped/);
    expect(taskSource).toMatch(/onAutoReviewCircuitBreaker\(\)/);
    expect(taskSource).toMatch(/agent_auto_review_circuit_breaker/);
    expect(taskSource).toMatch(
      /A reviewer denial means the action is not safe to approve[\s\S]*continue into the durable human approval flow/,
    );
    expect(taskSource).not.toMatch(/Automatic review denied this action/);

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
    expect(taskSource).toMatch(
      /type: "data-agent-auto-review"[\s\S]*approvalId,[\s\S]*toolCallId: request\.toolCallId,[\s\S]*autoReview,/,
    );
  });

  it("streams a privacy-safe automatic review lifecycle around the reviewer", () => {
    expect(taskSource).toMatch(
      /status: "reviewing",[\s\S]*await reviewAgentToolAction\(/,
    );
    expect(taskSource).toMatch(
      /completeAutoReviewLifecycle\("approved"\)[\s\S]*approvalSource: "auto_review"/,
    );
    expect(taskSource).toMatch(
      /completeAutoReviewLifecycle\("needs_approval"\)[\s\S]*type: "tool-approval-request"/,
    );
    expect(taskSource).toMatch(
      /finally \{[\s\S]*completeAutoReviewLifecycle\("dismissed"\)/,
    );

    const lifecycleWriterStart = taskSource.indexOf(
      'type: "data-agent-auto-review-lifecycle"',
    );
    const lifecycleWriterEnd = taskSource.indexOf(
      "} as AgentLongUiStreamPart",
      lifecycleWriterStart,
    );
    const lifecycleWriterSource = taskSource.slice(
      lifecycleWriterStart,
      lifecycleWriterEnd,
    );
    expect(lifecycleWriterSource).not.toMatch(
      /command|target|path|prompt|rationale|credential/,
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
  });

  it("routes an unavailable Auto review entitlement lookup to durable human approval", () => {
    const autoApproveBranch = findRequiredSource(
      'if (decision.verdict === "approve")',
    );
    const revalidateCall = findRequiredSource(
      "await revalidateAfterAutoReview",
      autoApproveBranch,
    );
    const catchStart = findRequiredSource("} catch (error) {", revalidateCall);
    const unavailableBranch = findRequiredSource(
      "AgentAutoReviewEntitlementRevalidationUnavailableError",
      catchStart,
    );
    const denyBranch = findRequiredSource("} else {", unavailableBranch);
    const postCatchApproveCheck = findRequiredSource(
      'if (autoReviewDecision?.verdict === "approve")',
      denyBranch,
    );
    const unavailableSource = taskSource.slice(unavailableBranch, denyBranch);
    const catchSource = taskSource.slice(catchStart, postCatchApproveCheck);
    const approvalSessionCheck = findRequiredSource(
      "if (!approvalSessionId)",
      postCatchApproveCheck,
    );
    const markPending = findRequiredSource(
      "await setApprovalPending(",
      approvalSessionCheck,
    );
    const waitForApproval = findRequiredSource(
      "await waitForApprovalInput",
      markPending,
    );

    expect(unavailableSource).toMatch(
      /verdict: "ask_user"[\s\S]*failureClass: "provider_error"/,
    );
    expect(unavailableSource).not.toMatch(/return \{/);
    expect(catchSource).not.toMatch(/onPostWaitAuthorizationDenied\(\)/);
    expect(markPending).toBeGreaterThan(approvalSessionCheck);
    expect(waitForApproval).toBeGreaterThan(markPending);
  });

  it("denies a changed Auto review authorization without aborting the Agent run", () => {
    const autoApproveBranch = findRequiredSource(
      'if (decision.verdict === "approve")',
    );
    const revalidateCall = findRequiredSource(
      "await revalidateAfterAutoReview",
      autoApproveBranch,
    );
    const catchStart = findRequiredSource("} catch (error) {", revalidateCall);
    const unavailableBranch = findRequiredSource(
      "AgentAutoReviewEntitlementRevalidationUnavailableError",
      catchStart,
    );
    const denyBranch = findRequiredSource("} else {", unavailableBranch);
    const postCatchApproveCheck = findRequiredSource(
      'if (autoReviewDecision?.verdict === "approve")',
      denyBranch,
    );
    const denySource = taskSource.slice(denyBranch, postCatchApproveCheck);

    expect(denySource).toMatch(/authorization_denied/);
    expect(denySource).toMatch(
      /return \{[\s\S]*approved: false[\s\S]*APPROVAL_AUTHORIZATION_DENIED_REASON/,
    );
    expect(denySource).not.toMatch(/onPostWaitAuthorizationDenied\(\)/);
  });
});
