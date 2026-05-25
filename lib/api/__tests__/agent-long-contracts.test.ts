/**
 * Structural contract tests for the three non-obvious agent-long reliability
 * invariants that are easy to break in a well-meaning refactor:
 *
 *   1. Transport STREAM_TIMEOUT_MS guard — prevents SSE hanging forever when
 *      a Trigger.dev task fails before registering its stream.
 *   2. Cancel compare-and-clear (expectedRunId) — TOCTOU guard preventing
 *      concurrent cancels from stomping each other's stored run ID.
 *   3. Resume 204 on terminal + self-heal on 404 — prevents infinite
 *      reconnect loops when a run has already ended.
 *
 * Follows the pattern in chat-handler-pty-cleanup.test.ts: read source,
 * assert structural presence — no Trigger.dev SDK mocking required.
 */

import fs from "fs";
import path from "path";

const transportSrc = fs.readFileSync(
  path.resolve(__dirname, "../../chat/agent-long-transport.ts"),
  "utf8",
);

const cancelSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent-long/cancel/route.ts"),
  "utf8",
);

const resumeSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent-long/resume/route.ts"),
  "utf8",
);

const routeSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent-long/route.ts"),
  "utf8",
);

const taskSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../trigger/agent-long.ts"),
  "utf8",
);

describe("agent-long-transport — STREAM_TIMEOUT_MS guard", () => {
  test("STREAM_TIMEOUT_MS is set to 30 seconds", () => {
    expect(transportSrc).toMatch(/STREAM_TIMEOUT_MS\s*=\s*30[_,]?000/);
  });

  test("setTimeout uses sendAbortAndClose with STREAM_TIMEOUT_MS", () => {
    expect(transportSrc).toMatch(
      /setTimeout\(\s*sendAbortAndClose\s*,\s*STREAM_TIMEOUT_MS\s*\)/,
    );
  });

  test("clearTimeout is called after normal subscription end", () => {
    expect(transportSrc).toMatch(/clearTimeout\(\s*timeoutId\s*\)/);
  });
});

describe("agent-long cancel route — compare-and-clear idempotency", () => {
  test("runs.cancel is called before clearing the stored run ID", () => {
    const cancelCallIdx = cancelSrc.indexOf("runs.cancel(runId)");
    // Search for the actual call site after runs.cancel, not the import
    const clearCallIdx = cancelSrc.indexOf(
      "setActiveTriggerRun({",
      cancelCallIdx,
    );
    expect(cancelCallIdx).toBeGreaterThan(-1);
    expect(clearCallIdx).toBeGreaterThan(cancelCallIdx);
  });

  test("setActiveTriggerRun receives expectedRunId to prevent TOCTOU race", () => {
    expect(cancelSrc).toMatch(/expectedRunId\s*:\s*runId/);
  });
});

describe("agent-long resume route — 204 on terminal + self-heal on 404", () => {
  test("returns 204 when stored run is in a terminal state", () => {
    const terminalCheckIdx = resumeSrc.indexOf(
      "TERMINAL_STATUSES.has(runStatus)",
    );
    expect(terminalCheckIdx).toBeGreaterThan(-1);

    const status204AfterCheck = resumeSrc.indexOf(
      "status: 204",
      terminalCheckIdx,
    );
    expect(status204AfterCheck).toBeGreaterThan(terminalCheckIdx);
  });

  test('maps ApiError 404 to "EXPIRED" so it is caught by terminal-status check', () => {
    expect(resumeSrc).toMatch(/ApiError.*404|err\.status\s*===\s*404/s);
    const notFoundIdx = resumeSrc.search(/err\.status\s*===\s*404/);
    expect(notFoundIdx).toBeGreaterThan(-1);

    const expiredAfterNotFound = resumeSrc.indexOf('"EXPIRED"', notFoundIdx);
    expect(expiredAfterNotFound).toBeGreaterThan(notFoundIdx);
  });

  test("returns 204 when no active run ID is stored", () => {
    expect(resumeSrc).toMatch(/status:\s*204/);
  });
});

describe("agent-long task — Trigger.dev dashboard error visibility", () => {
  test("runs are triggered with filterable queued metadata and tags", () => {
    expect(routeSrc).toMatch(/tags:\s*triggerTags/);
    expect(routeSrc).toMatch(/metadata:\s*{/);
    expect(routeSrc).toMatch(/status:\s*"queued"/);
    expect(routeSrc).toMatch(/loginRequired:\s*false/);
  });

  test("persisted chats send a trimmed Trigger payload and retain attachment exceptions", () => {
    expect(routeSrc).toMatch(
      /const messagesForPayload\s*=\s*temporary\s*\|\|\s*localDesktopAttachmentsPrepared\s*\?\s*messagesForTrigger\s*:\s*\[\]/s,
    );
    expect(routeSrc).toMatch(/messages:\s*messagesForPayload/);
  });

  test("public token creation and active run persistence are overlapped", () => {
    const parallelIdx = routeSrc.indexOf("await Promise.all([");
    const tokenIdx = routeSrc.indexOf("auth.createPublicToken", parallelIdx);
    const activeRunIdx = routeSrc.indexOf("setActiveTriggerRun", parallelIdx);

    expect(parallelIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(parallelIdx);
    expect(activeRunIdx).toBeGreaterThan(parallelIdx);
  });

  test("handled user rate limits are returned after the UI error chunk is flushed", () => {
    const waitIdx = taskSrc.indexOf("await waitUntilComplete()");
    const streamErrorIdx = taskSrc.indexOf("if (terminalStreamError)", waitIdx);
    const handledRateLimitIdx = taskSrc.indexOf(
      "isHandledUserRateLimitError(terminalStreamError)",
      streamErrorIdx,
    );
    const returnIdx = taskSrc.indexOf(
      "return { chatId, assistantMessageId }",
      handledRateLimitIdx,
    );
    expect(waitIdx).toBeGreaterThan(-1);
    expect(streamErrorIdx).toBeGreaterThan(waitIdx);
    expect(handledRateLimitIdx).toBeGreaterThan(streamErrorIdx);
    expect(returnIdx).toBeGreaterThan(handledRateLimitIdx);
  });

  test("non-rate-limit stream errors are still rethrown after the handled branch", () => {
    const streamErrorIdx = taskSrc.indexOf("if (terminalStreamError)");
    const handledRateLimitIdx = taskSrc.indexOf(
      "isHandledUserRateLimitError(terminalStreamError)",
      streamErrorIdx,
    );
    const throwIdx = taskSrc.indexOf(
      "throw terminalStreamError",
      handledRateLimitIdx,
    );
    expect(streamErrorIdx).toBeGreaterThan(-1);
    expect(handledRateLimitIdx).toBeGreaterThan(streamErrorIdx);
    expect(throwIdx).toBeGreaterThan(streamErrorIdx);
  });

  test("provider finishReason error fails the task after the UI stream drains", () => {
    const waitIdx = taskSrc.indexOf("await waitUntilComplete()");
    const terminalErrorIdx = taskSrc.indexOf(
      "getTerminalProviderStreamError(terminalAgentState)",
      waitIdx,
    );
    const throwIdx = taskSrc.indexOf(
      "throw terminalStreamError",
      terminalErrorIdx,
    );

    expect(waitIdx).toBeGreaterThan(-1);
    expect(terminalErrorIdx).toBeGreaterThan(waitIdx);
    expect(throwIdx).toBeGreaterThan(terminalErrorIdx);
  });

  test("outer catch checks live usage tracker before refunding", () => {
    const liveUsagePredicateIdx = taskSrc.indexOf(
      "const hasObservedUsage = () => !!observedUsageTracker?.hasUsage",
    );
    const cleanupMapIdx = taskSrc.indexOf(
      "runCleanupMap.set(ctx.run.id",
      liveUsagePredicateIdx,
    );
    const refundGuardIdx = taskSrc.indexOf("if (!hasObservedUsage())");
    const onCancelIdx = taskSrc.indexOf("onCancel: async");
    const cancelRefundGuardIdx = taskSrc.indexOf(
      "if (!cleanup.hasObservedUsage())",
      onCancelIdx,
    );
    const cancelRefundIdx = taskSrc.indexOf(
      "cleanup.usageRefundTracker.refund()",
      onCancelIdx,
    );

    expect(liveUsagePredicateIdx).toBeGreaterThan(-1);
    expect(cleanupMapIdx).toBeGreaterThan(liveUsagePredicateIdx);
    expect(refundGuardIdx).toBeGreaterThan(liveUsagePredicateIdx);
    expect(onCancelIdx).toBeGreaterThan(-1);
    expect(cancelRefundGuardIdx).toBeGreaterThan(onCancelIdx);
    expect(cancelRefundIdx).toBeGreaterThan(cancelRefundGuardIdx);
    expect(taskSrc).not.toMatch(/hasObservedUsage\s*=\s*hasObservedUsage/);
  });

  test("task catch records structured metadata for dashboard filtering", () => {
    expect(taskSrc).toMatch(/recordAgentLongFailureForDashboard/);
    expect(taskSrc).toMatch(/errorCategory/);
    expect(taskSrc).toMatch(/loginRequired/);
    expect(taskSrc).toMatch(/login_required/);
    expect(taskSrc).toMatch(/error_\$\{summary\.category\}/);
    expect(taskSrc).toMatch(/metadata\.flush\(\)/);
  });
});
