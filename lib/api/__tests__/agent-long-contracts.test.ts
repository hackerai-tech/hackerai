/**
 * Structural contract tests for the three non-obvious agent-long reliability
 * invariants that are easy to break in a well-meaning refactor:
 *
 *   1. Transport reads the Trigger.dev "ui" stream directly and keeps a
 *      first-chunk timeout guard — prevents late stream discovery from turning
 *      live output into completion-time replay.
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

const dbActionsSrc = fs.readFileSync(
  path.resolve(__dirname, "../../db/actions.ts"),
  "utf8",
);

describe("agent-long-transport — direct UI stream reader", () => {
  test("reads the Trigger.dev ui stream directly instead of using withStreams", () => {
    expect(transportSrc).toMatch(/streams\.read<unknown>\(/);
    expect(transportSrc).toMatch(/AGENT_UI_STREAM_ID/);
    expect(transportSrc).not.toMatch(/\.withStreams\(/);
  });

  test("STREAM_TIMEOUT_MS leaves room for Trigger queueing and setup", () => {
    expect(transportSrc).toMatch(
      /STREAM_TIMEOUT_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,
    );
    expect(transportSrc).toMatch(/STREAM_IDLE_TIMEOUT_SECONDS/);
  });

  test("failed run statuses abort the direct stream reader", () => {
    expect(transportSrc).toMatch(/runs\.subscribeToRun\(runId/);
    expect(transportSrc).toMatch(/TERMINAL_RUN_STATUSES\.has\(status\)/);
    expect(transportSrc).toMatch(/readAbortController\?\.abort\(\)/);
  });

  test("setTimeout aborts the stream reader and closes the SSE", () => {
    const timeoutIdx = transportSrc.indexOf("setTimeout(() =>");
    const abortIdx = transportSrc.indexOf(
      "readAbortController?.abort()",
      timeoutIdx,
    );
    const closeIdx = transportSrc.indexOf("sendAbortAndClose()", timeoutIdx);

    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(timeoutIdx);
    expect(closeIdx).toBeGreaterThan(abortIdx);
  });

  test("clearTimeout is called after normal stream end", () => {
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
  test("uses a paid two-hour task cap with a separate free-plan runtime cap", () => {
    expect(taskSrc).toMatch(
      /AGENT_LONG_FREE_MAX_DURATION_SECONDS\s*=\s*60\s*\*\s*60/,
    );
    expect(taskSrc).toMatch(
      /AGENT_LONG_PAID_MAX_DURATION_SECONDS\s*=\s*2\s*\*\s*60\s*\*\s*60/,
    );
    expect(taskSrc).toMatch(
      /AGENT_LONG_TRIGGER_MAX_DURATION_SECONDS\s*=\s*AGENT_LONG_PAID_MAX_DURATION_SECONDS/,
    );
    expect(taskSrc).toMatch(
      /subscription\s*===\s*"free"[\s\S]*AGENT_LONG_FREE_MAX_DURATION_SECONDS[\s\S]*AGENT_LONG_PAID_MAX_DURATION_SECONDS/,
    );
    expect(taskSrc).toMatch(
      /maxDuration:\s*AGENT_LONG_TRIGGER_MAX_DURATION_SECONDS/,
    );
    expect(taskSrc).toMatch(/maxDurationMs:\s*agentLongMaxDurationMs/);
  });

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

  test("empty rehydrated history is classified separately from oversized input", () => {
    const emptyPromptIdx = dbActionsSrc.indexOf("chat_prompt_empty");
    const emptyMessageIdx = dbActionsSrc.indexOf(
      "No message content was found for this request",
      emptyPromptIdx,
    );
    const tooLargeIdx = dbActionsSrc.indexOf(
      "Your input (including any attached files) is too large",
      emptyMessageIdx,
    );

    expect(emptyPromptIdx).toBeGreaterThan(-1);
    expect(emptyMessageIdx).toBeGreaterThan(emptyPromptIdx);
    expect(tooLargeIdx).toBeGreaterThan(emptyMessageIdx);
    expect(dbActionsSrc).toMatch(/empty_prompt:\s*true/);
    expect(taskSrc).toMatch(/errorMetadata\?\.empty_prompt\s*===\s*true/);
    expect(taskSrc).toMatch(/"empty_prompt"/);
  });

  test("agent-long DB rehydrate failures are not swallowed when no payload messages exist", () => {
    const fetchFailedIdx = dbActionsSrc.indexOf("chat_history_fetch_failed");
    const zeroNewMessagesIdx = dbActionsSrc.indexOf(
      "newMessages.length === 0",
      fetchFailedIdx,
    );
    const rethrowIdx = dbActionsSrc.indexOf(
      'databaseError("messages.getMessagesPageForBackend"',
      zeroNewMessagesIdx,
    );

    expect(fetchFailedIdx).toBeGreaterThan(-1);
    expect(zeroNewMessagesIdx).toBeGreaterThan(fetchFailedIdx);
    expect(rethrowIdx).toBeGreaterThan(zeroNewMessagesIdx);
  });

  test("normal agent-long sends reject empty message payloads before triggering", () => {
    const guardIdx = routeSrc.indexOf("requestMessages.length === 0");
    const emptyPayloadIdx = routeSrc.indexOf(
      "agent_long_empty_message_payload_rejected",
    );
    const triggerIdx = routeSrc.indexOf("tasks.trigger", emptyPayloadIdx);

    expect(guardIdx).toBeGreaterThan(-1);
    expect(emptyPayloadIdx).toBeGreaterThan(guardIdx);
    expect(triggerIdx).toBeGreaterThan(emptyPayloadIdx);
  });
});
