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

const triggerBrowserRealtimeSrc = fs.readFileSync(
  path.resolve(__dirname, "../../chat/trigger-browser-realtime.ts"),
  "utf8",
);

const cancelSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-cancel-route.ts"),
  "utf8",
);

const resumeSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-resume-route.ts"),
  "utf8",
);

const routeSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-trigger-route.ts"),
  "utf8",
);

const agentRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent/route.ts"),
  "utf8",
);

const legacyAgentRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent-long/route.ts"),
  "utf8",
);

const agentEndpointsSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-endpoints.ts"),
  "utf8",
);

const agentRouteErrorsSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-route-errors.ts"),
  "utf8",
);

const chatComponentSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/components/chat.tsx"),
  "utf8",
);

const chatItemSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/components/ChatItem.tsx"),
  "utf8",
);

const globalStateSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/contexts/GlobalState.tsx"),
  "utf8",
);

const convexMessagesSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../convex/messages.ts"),
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

const chatHandlerSrc = fs.readFileSync(
  path.resolve(__dirname, "../chat-handler.ts"),
  "utf8",
);

const agentStreamRunnerSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-stream-runner.ts"),
  "utf8",
);

const toolSchemasSrc = fs.readFileSync(
  path.resolve(__dirname, "../../ai/tools/schemas.ts"),
  "utf8",
);

const toolExecutionSources = [
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/run-terminal-cmd.ts"),
      "utf8",
    ),
    schemaNames: ["runTerminalCmdTool"],
  },
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/interact-terminal-session.ts"),
      "utf8",
    ),
    schemaNames: ["interactTerminalSessionTool"],
  },
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/get-terminal-files.ts"),
      "utf8",
    ),
    schemaNames: ["getTerminalFilesTool"],
  },
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/file.ts"),
      "utf8",
    ),
    schemaNames: ["fileToolSchema"],
  },
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/todo-write.ts"),
      "utf8",
    ),
    schemaNames: ["todoWriteTool"],
  },
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/web-search.ts"),
      "utf8",
    ),
    schemaNames: ["webSearchTool"],
  },
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/open-url.ts"),
      "utf8",
    ),
    schemaNames: ["openUrlTool"],
  },
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/notes.ts"),
      "utf8",
    ),
    schemaNames: [
      "createNoteTool",
      "listNotesTool",
      "updateNoteTool",
      "deleteNoteTool",
    ],
  },
];

describe("agent tool schemas — Head Start bundle boundary", () => {
  test("schema-only tool catalog imports only ai and zod", () => {
    const importSources = Array.from(
      toolSchemasSrc.matchAll(/^import\s+[^;]+?\s+from\s+"([^"]+)";/gm),
    ).map((match) => match[1]);

    expect(importSources).toEqual(["ai", "zod"]);
    expect(toolSchemasSrc).not.toMatch(/from\s+"@\/[^"]+"/);
    expect(toolSchemasSrc).not.toMatch(/from\s+"\.\.?\/[^"]+"/);
    expect(toolSchemasSrc).not.toMatch(/\bexecute\s*:/);
  });

  test("schema-only catalog covers current agent and ask tool gating", () => {
    expect(toolSchemasSrc).toMatch(/createAgentToolSchemaSet/);
    expect(toolSchemasSrc).toMatch(/run_terminal_cmd:\s*runTerminalCmdTool/);
    expect(toolSchemasSrc).toMatch(
      /interact_terminal_session:\s*interactTerminalSessionTool/,
    );
    expect(toolSchemasSrc).toMatch(
      /get_terminal_files:\s*getTerminalFilesTool/,
    );
    expect(toolSchemasSrc).toMatch(
      /file:\s*createFileToolSchema\(\{\s*supportsView:\s*supportsFileView/,
    );
    expect(toolSchemasSrc).toMatch(/todo_write:\s*todoWriteTool/);
    expect(toolSchemasSrc).toMatch(/create_note:\s*createNoteTool/);
    expect(toolSchemasSrc).toMatch(/web_search:\s*webSearchTool/);
    expect(toolSchemasSrc).toMatch(/open_url:\s*openUrlTool/);
    expect(toolSchemasSrc).toMatch(/if\s*\(\s*mode\s*===\s*"ask"\s*\)/);
  });

  test("execution factories layer execute implementations onto shared schemas", () => {
    for (const { src, schemaNames } of toolExecutionSources) {
      for (const schemaName of schemaNames) {
        expect(src).toMatch(new RegExp(`\\.\\.\\.${schemaName}`));
      }
      expect(src).toMatch(/\bexecute\s*:/);
    }
  });
});

describe("agent-long-transport — direct UI stream reader", () => {
  test("reads the Trigger.dev ui stream directly through the browser realtime helper", () => {
    expect(transportSrc).toMatch(/readTriggerRunStream<unknown>\(/);
    expect(transportSrc).toMatch(/AGENT_UI_STREAM_ID/);
    expect(transportSrc).not.toMatch(/@trigger\.dev\/sdk/);
    expect(transportSrc).not.toMatch(/\.withStreams\(/);
  });

  test("STREAM_TIMEOUT_MS leaves room for Trigger queueing and setup", () => {
    expect(transportSrc).toMatch(
      /STREAM_TIMEOUT_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,
    );
    expect(transportSrc).toMatch(/STREAM_IDLE_TIMEOUT_SECONDS/);
  });

  test("failed run statuses abort the direct stream reader", () => {
    expect(transportSrc).toMatch(/retrieveTriggerRunStatus\(/);
    expect(transportSrc).toMatch(/pollRunStatusForTerminalRun/);
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

  test("drains post-finish data chunks before closing the browser stream", () => {
    expect(transportSrc).toMatch(/POST_FINISH_DRAIN_TIMEOUT_MS/);
    expect(transportSrc).toMatch(/sawFinishChunk/);
    expect(transportSrc).toMatch(
      /chunkType\s*===\s*"finish"[\s\S]*sawFinishChunk\s*=\s*true[\s\S]*continue;/,
    );
    expect(transportSrc).not.toMatch(
      /chunkType\s*===\s*"finish"[\s\S]{0,220}break;/,
    );
  });

  test("completed runs drain briefly and then close normally when finish is missing", () => {
    expect(transportSrc).toMatch(/COMPLETED_RUN_DRAIN_TIMEOUT_MS/);
    expect(transportSrc).toMatch(/QUIET_STREAM_STATUS_POLL_INTERVAL_MS/);
    expect(transportSrc).toMatch(/QUIET_STREAM_STATUS_POLL_AFTER_MS/);
    expect(transportSrc).toMatch(/status\s*===\s*"COMPLETED"/);
    expect(transportSrc).toMatch(/startCompletedRunDrainTimer\(\)/);
    expect(transportSrc).toMatch(/retrieveTriggerRunStatus\(/);
    expect(transportSrc).toMatch(/options\?\.chatId\s*\?\?\s*handle\.chatId/);
    expect(transportSrc).toMatch(/completedRunDrainPromise/);
    expect(transportSrc).toMatch(/completedRunDrainElapsed\s*=\s*true/);
    expect(transportSrc).toMatch(/enqueueSyntheticFinish\(\)/);
    expect(transportSrc).toMatch(
      /completedRunDrainElapsed\s*=\s*true[\s\S]*enqueueSyntheticFinish\(\)[\s\S]*sawTerminalChunk\s*=\s*true[\s\S]*break;/,
    );
    expect(transportSrc).toMatch(
      /userAborted\s*\|\|\s*timedOutAfterFinish\s*\|\|\s*completedRunDrainElapsed/,
    );
  });

  test("browser stream cancellation releases Trigger realtime subscriptions", () => {
    expect(transportSrc).toMatch(/cancelRealtimeSubscriptions/);
    expect(transportSrc).toMatch(/activeAgentLongRealtimeCancels/);
    expect(transportSrc).toMatch(/cancelAgentLongRealtimeStreams/);
    expect(transportSrc).toMatch(/registerAgentLongRealtimeCancel/);
    expect(transportSrc).toMatch(/statusMonitorInterval/);
    expect(transportSrc).toMatch(/clearInterval\(statusMonitorInterval\)/);
    expect(transportSrc).toMatch(/statusPollInterval/);
    expect(transportSrc).toMatch(/clearInterval\(statusPollInterval\)/);
    expect(transportSrc).toMatch(/streamIterator\?\.return\?\.\(undefined\)/);
    expect(transportSrc).toMatch(
      /cancelConsumerRealtime[\s\S]*consumerCanceled\s*=\s*true/,
    );
    expect(transportSrc).toMatch(
      /cancel\(\)\s*\{[\s\S]*cancelConsumerRealtime\(\)/,
    );
  });

  test("does not close an already errored browser stream controller", () => {
    const abortAndCloseIdx = transportSrc.indexOf(
      "const sendAbortAndClose = () =>",
    );
    const closeHelperIdx = transportSrc.indexOf("const close = () =>");

    expect(abortAndCloseIdx).toBeGreaterThan(-1);
    expect(closeHelperIdx).toBeGreaterThan(abortAndCloseIdx);
    expect(transportSrc).toMatch(/controller\.desiredSize\s*===\s*null/);
    const abortAndCloseSrc = transportSrc.slice(
      abortAndCloseIdx,
      closeHelperIdx,
    );
    expect(abortAndCloseSrc).toMatch(
      /if\s*\(\s*!isControllerErrored\(\)\s*\)[\s\S]*controller\.enqueue\(/,
    );
    expect(abortAndCloseSrc).toMatch(/controller\.close\(\)/);
  });

  test("browser realtime helper resumes Trigger streams after clean SSE disconnects", () => {
    expect(triggerBrowserRealtimeSrc).toMatch(/Last-Event-ID/);
    expect(triggerBrowserRealtimeSrc).toMatch(/lastEventId/);
    expect(triggerBrowserRealtimeSrc).toMatch(/receivedEventOnConnection/);
    expect(triggerBrowserRealtimeSrc).toMatch(
      /await waitForRetry\(\s*retryCount\s*,\s*abortController\.signal\s*\)/,
    );
  });
});

describe("agent stream runner — empty tool-input recovery", () => {
  test("temporarily excludes tools when the doom-loop detector requests it", () => {
    expect(agentStreamRunnerSrc).toMatch(/activeToolExclusions/);
    expect(agentStreamRunnerSrc).toMatch(/getActiveToolsWithExclusions/);
    expect(agentStreamRunnerSrc).toMatch(/getActiveToolsForRecovery/);
    expect(agentStreamRunnerSrc).toMatch(
      /event:\s*"doom_loop_tool_exclusion_recovery"/,
    );

    const recoveryIdx = agentStreamRunnerSrc.indexOf(
      "const loopRecovery = getDoomLoopRecovery(steps, steps.length)",
    );
    const summarizationIdx = agentStreamRunnerSrc.indexOf(
      "runSummarizationStep({",
    );
    const summarizedActiveToolsIdx = agentStreamRunnerSrc.indexOf(
      "const activeTools = await getActiveToolsForRecovery(loopRecovery)",
      summarizationIdx,
    );
    const normalActiveToolsIdx = agentStreamRunnerSrc.indexOf(
      "const activeTools = await getActiveToolsForRecovery(loopRecovery)",
      summarizedActiveToolsIdx + 1,
    );
    const summarizedNudgeIdx = agentStreamRunnerSrc.indexOf(
      "loopRecovery.nudge",
      summarizationIdx,
    );

    expect(recoveryIdx).toBeGreaterThan(-1);
    expect(summarizationIdx).toBeGreaterThan(recoveryIdx);
    expect(summarizedActiveToolsIdx).toBeGreaterThan(summarizationIdx);
    expect(normalActiveToolsIdx).toBeGreaterThan(summarizedActiveToolsIdx);
    expect(summarizedNudgeIdx).toBeGreaterThan(summarizationIdx);
    expect(agentStreamRunnerSrc).toMatch(
      /getActiveToolsWithExclusions\(recovery\.excludedTools\)/,
    );
  });
});

describe("agent-long chat UI — completion reconciliation", () => {
  test("polls the resume endpoint and clears useChat state after backend completion", () => {
    expect(chatComponentSrc).toMatch(/AGENT_LONG_COMPLETION_POLL_DELAY_MS/);
    expect(chatComponentSrc).toMatch(/AGENT_LONG_COMPLETION_QUIET_MS/);
    expect(chatComponentSrc).toMatch(/AGENT_LONG_COMPLETION_STOP_GRACE_MS/);
    expect(chatComponentSrc).toMatch(/AGENT_RESUME_ENDPOINT/);
    expect(chatComponentSrc).toMatch(/response\.status\s*===\s*204/);
    expect(chatComponentSrc).toMatch(/scheduleFinishLocally\(\)/);
    expect(chatComponentSrc).toMatch(/finishLocally\(\)/);
    expect(chatComponentSrc).toMatch(/stop\(\)/);
    expect(chatComponentSrc).toMatch(/window\.history\.replaceState/);
    expect(chatComponentSrc).toMatch(/setIsExistingChat\(true\)/);
  });

  test("stops the local stream when a streaming chat unmounts", () => {
    expect(chatComponentSrc).toMatch(/const stopRef = useRef\(stop\)/);
    expect(chatComponentSrc).toMatch(/stopActiveBrowserStream/);
    expect(chatComponentSrc).toMatch(
      /cancelAgentLongRealtimeStreams\(activeChatIdRef\.current\)/,
    );
    expect(chatComponentSrc).toMatch(
      /statusRef\.current\s*===\s*"streaming"[\s\S]*statusRef\.current\s*===\s*"submitted"[\s\S]*stopRef\.current\(\)/,
    );
    expect(chatComponentSrc).toMatch(
      /return\s*\(\)\s*=>\s*\{\s*stopActiveBrowserStream\(\);[\s\S]*\}/,
    );
  });

  test("sidebar navigation cancels stale agent-long realtime before route commit", () => {
    expect(chatItemSrc).toMatch(/cancelAgentLongRealtimeStreams/);
    expect(chatItemSrc).toMatch(/setOptimisticChatId\(id\)/);
    expect(chatItemSrc).toMatch(/optimisticChatId\s*\?\?\s*routeChatId/);
    expect(chatItemSrc).toMatch(
      /routeChatId\s*&&\s*routeChatId\s*!==\s*id[\s\S]*cancelAgentLongRealtimeStreams\(routeChatId\)/,
    );
    expect(globalStateSrc).toMatch(/optimisticChatId:\s*string\s*\|\s*null/);
    expect(globalStateSrc).toMatch(/setOptimisticChatId/);
  });

  test("suppresses only the known agent-long double-close browser noise", () => {
    expect(chatComponentSrc).toMatch(/suppressAgentLongDoubleCloseNoise/);
    expect(chatComponentSrc).toMatch(
      /shouldUseAgentLongForCurrentChatRef\.current/,
    );
    expect(chatComponentSrc).toMatch(/Cannot close an errored readable stream/);
    expect(chatComponentSrc).toMatch(
      /ReadableStreamDefaultController is not in a state where it can be closed/,
    );
    expect(chatComponentSrc).toMatch(
      /Cannot close a stream that is already closed/,
    );
    expect(chatComponentSrc).toMatch(/event\.preventDefault\(\)/);
  });

  test("guards auto-resume and stream data against stale chat switches", () => {
    expect(chatComponentSrc).toMatch(/chatDataForCurrentChat/);
    expect(chatComponentSrc).toMatch(
      /chatDataForCurrentChat\?\.active_stream_id/,
    );
    expect(chatComponentSrc).toMatch(
      /chatDataForCurrentChat\?\.active_trigger_run_id/,
    );
    expect(chatComponentSrc).toMatch(/paginatedMessageResults/);
    expect(chatComponentSrc).not.toMatch(
      /\[\.\.\.paginatedMessages\.results\]\.reverse\(\)/,
    );
    expect(chatComponentSrc).not.toMatch(/message\.chat_id\s*===\s*undefined/);
    expect(chatComponentSrc).toMatch(/message\.chat_id\s*===\s*chatId/);
    expect(chatComponentSrc).toMatch(/__chatId:\s*chatId/);
    expect(chatComponentSrc).toMatch(/activeChatIdRef\.current\s*!==\s*chatId/);
    expect(chatComponentSrc).toMatch(/shouldUseAgentLongForCurrentChat/);
    expect(convexMessagesSrc).toMatch(/chat_id:\s*v\.string\(\)/);
    expect(convexMessagesSrc).toMatch(/chat_id:\s*message\.chat_id/);
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

  test("returns chat id with the public run handle", () => {
    expect(resumeSrc).toMatch(
      /NextResponse\.json\(\{\s*runId,\s*publicAccessToken,\s*chatId\s*\}\)/,
    );
  });
});

describe("agent-long task — Trigger.dev dashboard error visibility", () => {
  test("uses /api/agent as the canonical route while keeping /api/agent-long as a compatibility alias", () => {
    expect(agentEndpointsSrc).toMatch(
      /AGENT_API_ENDPOINT\s*=\s*"\/api\/agent"/,
    );
    expect(agentEndpointsSrc).toMatch(
      /LEGACY_AGENT_API_ENDPOINT\s*=\s*"\/api\/agent-long"/,
    );
    expect(agentEndpointsSrc).toMatch(
      /AGENT_TRIGGER_TASK_ID\s*=\s*"agent-long"/,
    );
    expect(agentRouteSrc).toMatch(/AGENT_API_ENDPOINT/);
    expect(legacyAgentRouteSrc).toMatch(/LEGACY_AGENT_API_ENDPOINT/);
    expect(transportSrc).toMatch(/fetchWithErrorHandlers\(AGENT_API_ENDPOINT/);
    expect(routeSrc).toMatch(/endpoint,/);
    expect(taskSrc).toMatch(
      /payloadEndpoint\s*\?\?\s*LEGACY_AGENT_API_ENDPOINT/,
    );
    expect(agentRouteErrorsSrc).toMatch(/handleAgentRouteError/);
  });

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

  test("validates agent trigger request bodies before auth and Trigger work", () => {
    expect(routeSrc).toMatch(/parseAgentTriggerRequestBody/);
    expect(routeSrc).toMatch(/Invalid JSON body/);
    expect(routeSrc).toMatch(/chatId required/);
    expect(routeSrc).toMatch(/messages must be an array/);

    const parseIdx = routeSrc.indexOf("parseAgentTriggerRequestBody(req)");
    const authIdx = routeSrc.indexOf("await getUserIDAndPro(req)");
    const triggerIdx = routeSrc.indexOf("tasks.trigger", authIdx);

    expect(parseIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(parseIdx);
    expect(triggerIdx).toBeGreaterThan(authIdx);
  });

  test("uses a turn-scoped Trigger idempotency key for agent runs", () => {
    expect(routeSrc).toMatch(/idempotencyKeys/);
    expect(routeSrc).toMatch(/buildAgentRunIdempotencyKey/);
    expect(routeSrc).toMatch(/getLastRequestMessageId/);
    expect(routeSrc).toMatch(/scope:\s*"global"/);
    expect(routeSrc).toMatch(/idempotencyKey:\s*triggerIdempotencyKey/);
    expect(routeSrc).toMatch(/idempotencyKeyTTL:\s*"6h"/);
    expect(routeSrc).toMatch(/existingChat\?\.update_time/);
  });

  test("handled tool failures are visible in Trigger logs and metadata", () => {
    expect(taskSrc).toMatch(/recordAgentLongHandledToolFailureForDashboard/);
    expect(taskSrc).toMatch(/lastHandledToolFailureStatus/);
    expect(taskSrc).toMatch(/handled_tool_failure/);
    expect(taskSrc).toMatch(/buildTriggerTag\("tool_status_"/);
    expect(taskSrc).toMatch(
      /triggerLogger\.warn\("\[agent-long\] handled tool failure"/,
    );
    expect(taskSrc).toMatch(/const onToolFailure\s*=/);
    expect(taskSrc).toMatch(
      /void\s+recordAgentLongHandledToolFailureForDashboard/,
    );
    expect(taskSrc).not.toMatch(
      /await\s+recordAgentLongHandledToolFailureForDashboard/,
    );
    expect(taskSrc).toMatch(/handled tool failure dashboard update failed/);
    expect(taskSrc).toMatch(/onToolFailure,\s*\)/);
  });

  test("runs use small subscription-aware Trigger.dev priority offsets", () => {
    expect(routeSrc).toMatch(
      /AGENT_TRIGGER_PRIORITY_BY_SUBSCRIPTION:\s*Record<\s*SubscriptionTier,\s*number\s*>/,
    );
    expect(routeSrc).toMatch(/free:\s*0/);
    expect(routeSrc).toMatch(/pro:\s*5/);
    expect(routeSrc).toMatch(/"pro-plus":\s*5/);
    expect(routeSrc).toMatch(/ultra:\s*10/);
    expect(routeSrc).toMatch(/team:\s*5/);
    expect(routeSrc).toMatch(
      /\.\.\.\(triggerPriority\s*>\s*0\s*\?\s*{\s*priority:\s*triggerPriority\s*}\s*:\s*{}\)/,
    );
    expect(routeSrc).toMatch(/triggerPriority/);
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

  test("start route returns chat id with the public run handle", () => {
    expect(routeSrc).toMatch(
      /NextResponse\.json\(\{\s*runId:\s*handle\.id,\s*publicAccessToken,\s*chatId,/,
    );
  });

  test("emits hidden fast-start heartbeats before setup and model streaming can go quiet", () => {
    expect(taskSrc).toMatch(/createAgentLongHeartbeatPart/);
    expect(taskSrc).toMatch(/phase:\s*"setup"\s*\|\s*"model_stream"/);
    expect(taskSrc).toMatch(/transient:\s*true/);

    const executeIdx = taskSrc.indexOf("execute: async ({ writer })");
    const fastStartIdx = taskSrc.indexOf(
      'writeAgentLongFastStart(writer, "setup")',
      executeIdx,
    );
    const costCheckIdx = taskSrc.indexOf(
      "await assertUserCanMakeCostIncurringRequest(userId)",
      executeIdx,
    );

    expect(executeIdx).toBeGreaterThan(-1);
    expect(fastStartIdx).toBeGreaterThan(executeIdx);
    expect(costCheckIdx).toBeGreaterThan(fastStartIdx);

    const heartbeatWrapperIdx = taskSrc.indexOf(
      "const withAgentLongStreamHeartbeat",
    );
    const immediateModelHeartbeatIdx = taskSrc.indexOf(
      'safeEnqueue(createAgentLongHeartbeatPart("model_stream"))',
      heartbeatWrapperIdx,
    );
    const readerLoopIdx = taskSrc.indexOf(
      "void (async () =>",
      heartbeatWrapperIdx,
    );

    expect(heartbeatWrapperIdx).toBeGreaterThan(-1);
    expect(immediateModelHeartbeatIdx).toBeGreaterThan(heartbeatWrapperIdx);
    expect(readerLoopIdx).toBeGreaterThan(immediateModelHeartbeatIdx);
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

  test("provider stream errors with reasoning-only output can retry on fallback", () => {
    const helperImportIdx = taskSrc.indexOf("shouldRetryAgentLongWithFallback");
    const partsIdx = taskSrc.indexOf(
      "const lastAssistantMessageParts",
      helperImportIdx,
    );
    const retryDecisionIdx = taskSrc.indexOf(
      "shouldRetryAgentLongWithFallback(",
      partsIdx,
    );
    const terminalProviderErrorIdx = taskSrc.indexOf(
      "hasTerminalProviderStreamError:",
      retryDecisionIdx,
    );
    const retryModelIdx = taskSrc.indexOf(
      "const retryModel = shouldRetryWithoutImageToolResults",
      terminalProviderErrorIdx,
    );
    const fallbackIdx = taskSrc.indexOf(
      "const retryResult = await createStream(retryModel)",
      terminalProviderErrorIdx,
    );

    expect(helperImportIdx).toBeGreaterThan(-1);
    expect(partsIdx).toBeGreaterThan(helperImportIdx);
    expect(retryDecisionIdx).toBeGreaterThan(partsIdx);
    expect(terminalProviderErrorIdx).toBeGreaterThan(retryDecisionIdx);
    expect(retryModelIdx).toBeGreaterThan(terminalProviderErrorIdx);
    expect(fallbackIdx).toBeGreaterThan(retryModelIdx);
  });

  test("/api/chat provider stream errors with reasoning-only output can retry on fallback", () => {
    const helperImportIdx = chatHandlerSrc.indexOf(
      "shouldRetryProviderStreamWithFallback",
    );
    const partsIdx = chatHandlerSrc.indexOf(
      "const lastAssistantMessageParts",
      helperImportIdx,
    );
    const retryDecisionIdx = chatHandlerSrc.indexOf(
      "shouldRetryProviderStreamWithFallback(",
      partsIdx,
    );
    const terminalProviderErrorIdx = chatHandlerSrc.indexOf(
      "hasTerminalProviderStreamError:",
      retryDecisionIdx,
    );
    const retryModelIdx = chatHandlerSrc.indexOf(
      "const retryModel = shouldRetryWithoutImageToolResults",
      terminalProviderErrorIdx,
    );
    const fallbackIdx = chatHandlerSrc.indexOf(
      "const retryResult = await createStream(retryModel)",
      terminalProviderErrorIdx,
    );

    expect(helperImportIdx).toBeGreaterThan(-1);
    expect(partsIdx).toBeGreaterThan(helperImportIdx);
    expect(retryDecisionIdx).toBeGreaterThan(partsIdx);
    expect(terminalProviderErrorIdx).toBeGreaterThan(retryDecisionIdx);
    expect(retryModelIdx).toBeGreaterThan(terminalProviderErrorIdx);
    expect(fallbackIdx).toBeGreaterThan(retryModelIdx);
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
    expect(taskSrc).toMatch(/`error_\$\{summary\.category\}`/);
    expect(taskSrc).toMatch(/`user_correctable_\$\{summary\.category\}`/);
    expect(taskSrc).toMatch(/TRIGGER_TAG_MAX_LENGTH\s*=\s*64/);
    expect(taskSrc).toMatch(/buildTriggerTag/);
    expect(taskSrc).toMatch(/metadata\.flush\(\)/);
  });

  test("user-correctable agent-long request errors complete without failing Trigger", () => {
    expect(taskSrc).toMatch(/USER_CORRECTABLE_AGENT_LONG_ERROR_CATEGORIES/);
    expect(taskSrc).toMatch(/isUserCorrectableAgentLongErrorCategory/);
    expect(taskSrc).toMatch(/"login_required"/);
    expect(taskSrc).toMatch(/"user_correctable"/);
    expect(taskSrc).toMatch(/userCorrectable/);
    expect(taskSrc).toMatch(/user_correctable_code_/);
    expect(taskSrc).toMatch(/caughtErrorUserCorrectable/);

    const recordedFailureIdx = taskSrc.indexOf(
      "const recordedFailure = await recordAgentLongFailureForDashboard",
    );
    const syntheticFlushIdx = taskSrc.indexOf(
      "await waitForErrorStream()",
      recordedFailureIdx,
    );
    const handledReturnGuardIdx = taskSrc.indexOf(
      "recordedFailure.userCorrectable === true",
      syntheticFlushIdx,
    );
    const returnIdx = taskSrc.indexOf(
      "return { chatId, assistantMessageId }",
      handledReturnGuardIdx,
    );
    const throwIdx = taskSrc.indexOf("throw error", returnIdx);

    expect(recordedFailureIdx).toBeGreaterThan(-1);
    expect(syntheticFlushIdx).toBeGreaterThan(recordedFailureIdx);
    expect(handledReturnGuardIdx).toBeGreaterThan(syntheticFlushIdx);
    expect(returnIdx).toBeGreaterThan(handledReturnGuardIdx);
    expect(throwIdx).toBeGreaterThan(returnIdx);
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

  test("normal agent sends reject empty message payloads before triggering", () => {
    const guardIdx = routeSrc.indexOf("requestMessages.length === 0");
    const emptyPayloadIdx = routeSrc.indexOf(
      "agent_empty_message_payload_rejected",
    );
    const triggerIdx = routeSrc.indexOf("tasks.trigger", emptyPayloadIdx);

    expect(guardIdx).toBeGreaterThan(-1);
    expect(emptyPayloadIdx).toBeGreaterThan(guardIdx);
    expect(triggerIdx).toBeGreaterThan(emptyPayloadIdx);
  });

  test("empty-after-processing agent-long errors have their own diagnostics", () => {
    expect(taskSrc).toMatch(/getEmptyProcessedMessagesMetadata/);
    expect(chatHandlerSrc).toMatch(/getEmptyProcessedMessagesMetadata/);
    expect(taskSrc).toMatch(
      /errorMetadata\?\.empty_after_processing\s*===\s*true/,
    );
    expect(taskSrc).toMatch(/"empty_after_processing"/);
    expect(taskSrc).toMatch(/emptyAfterProcessing/);
    expect(taskSrc).toMatch(/processingInputMessageCount/);
    expect(taskSrc).toMatch(/processingInputUiOnlyPartCount/);
    expect(taskSrc).toMatch(/isUserCorrectableAgentLongErrorCategory/);
    expect(taskSrc).toMatch(/user-correctable request error/);
  });

  test("blocked local sandbox fallback errors are user-correctable diagnostics", () => {
    expect(taskSrc).toMatch(/localSandboxFallbackBlocked/);
    expect(taskSrc).toMatch(/"local_sandbox_fallback_blocked"/);
    expect(taskSrc).toMatch(/sandboxFallbackReason/);
    expect(taskSrc).toMatch(/requestedPreference/);
    expect(taskSrc).toMatch(/actualSandbox/);
    expect(taskSrc).toMatch(/isUserCorrectableAgentLongErrorCategory/);
    expect(taskSrc).toMatch(/user-correctable request error/);
  });

  test("agent-long only passes explicit Trigger.dev region when mapped", () => {
    const routingIdx = routeSrc.indexOf(
      "getTriggerRegionForVercelRequest(req)",
    );
    const triggerIdx = routeSrc.indexOf("tasks.trigger", routingIdx);
    const regionOptionIdx = routeSrc.indexOf(
      "...(triggerRegion ? { region: triggerRegion } : {})",
      triggerIdx,
    );

    expect(routingIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(routingIdx);
    expect(regionOptionIdx).toBeGreaterThan(triggerIdx);
    expect(routeSrc).not.toMatch(/vercelIpContinent|vercelIpCountry/);
    expect(routeSrc).not.toMatch(/trigger region routing/);
  });

  test("agent-long carries free quota subject into Trigger.dev enforcement", () => {
    expect(routeSrc).toMatch(/freeQuotaSubject/);
    expect(routeSrc).toMatch(/tasks\.trigger[\s\S]*freeQuotaSubject/);
    expect(taskSrc).toMatch(/freeQuotaSubject\?:\s*string/);
    expect(taskSrc).toMatch(
      /const freeUsageSubject\s*=\s*freeQuotaSubject\s*\?\?\s*userId/,
    );
    expect(taskSrc).toMatch(
      /acquireFreeRunConcurrencyLock\(\s*freeUsageSubject/,
    );
    expect(taskSrc).toMatch(/checkFreeMonthlyCostLimit\(freeUsageSubject\)/);
    expect(taskSrc).toMatch(/recordFreeMonthlyCost\(\s*freeUsageSubject/);
  });
});
