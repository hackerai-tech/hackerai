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

const statusSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-status-route.ts"),
  "utf8",
);

const agentApprovalSessionSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-approval-session.ts"),
  "utf8",
);

const agentApprovalRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-approval-route.ts"),
  "utf8",
);

const agentApprovalClientSrc = fs.readFileSync(
  path.resolve(__dirname, "../../chat/agent-approval-session.ts"),
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

const agentStatusRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent/status/route.ts"),
  "utf8",
);

const legacyAgentRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent-long/route.ts"),
  "utf8",
);

const legacyAgentStatusRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/agent-long/status/route.ts"),
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

const agentPartialSaveRouteSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-partial-save-route.ts"),
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

const toolIndexSrc = fs.readFileSync(
  path.resolve(__dirname, "../../ai/tools/index.ts"),
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
  {
    src: fs.readFileSync(
      path.resolve(__dirname, "../../ai/tools/findings.ts"),
      "utf8",
    ),
    schemaNames: ["createVulnerabilityReportTool"],
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
      /file:\s*createFileToolSchema\(\{\s*supportsView:\s*true/,
    );
    expect(toolSchemasSrc).toMatch(/todo_write:\s*todoWriteTool/);
    expect(toolSchemasSrc).toMatch(/create_note:\s*createNoteTool/);
    expect(toolSchemasSrc).toMatch(
      /create_vulnerability_report:\s*createVulnerabilityReportTool/,
    );
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

  test("normal and durable Agent share one persistent-only finding tool factory", () => {
    expect(chatHandlerSrc).toMatch(/createTools\(/);
    expect(taskSrc).toMatch(/createTools\(/);
    expect(toolIndexSrc).toMatch(
      /create_vulnerability_report:\s*createCreateVulnerabilityReport\(context\)/,
    );
    expect(toolIndexSrc).toMatch(/return\s+mode\s*===\s*"ask"/);
    expect(toolIndexSrc).toMatch(/\.\.\.\(!isTemporary\s*&&\s*\{/);
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

  test("proxies run status polling through same-origin routes", () => {
    expect(triggerBrowserRealtimeSrc).toMatch(/AGENT_STATUS_ENDPOINT/);
    expect(triggerBrowserRealtimeSrc).toMatch(/method:\s*"POST"/);
    expect(triggerBrowserRealtimeSrc).not.toMatch(/\/api\/v1\/runs/);
    expect(transportSrc).toMatch(/statusEndpoint/);
    expect(statusSrc).toMatch(/runs\.retrieve\(runId\)/);
    expect(statusSrc).toMatch(/ApiError/);
    expect(statusSrc).toMatch(/MISSING_RUN_STATUSES/);
    expect(statusSrc).toMatch(/Run not found/);
    expect(statusSrc).toMatch(/metadata\.chatId\s*===\s*expected\.chatId/);
    expect(statusSrc).toMatch(/metadata\.userId\s*===\s*expected\.userId/);
    expect(statusSrc).not.toMatch(/\/api\/v1\/runs/);
    expect(agentStatusRouteSrc).toMatch(/createAgentStatusPost/);
    expect(legacyAgentStatusRouteSrc).toMatch(/createAgentStatusPost/);
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
    expect(chatComponentSrc).toMatch(/AGENT_PARTIAL_SAVE_ENDPOINT/);
    expect(chatComponentSrc).toMatch(/saveAgentLongPartialSnapshot/);
    expect(chatComponentSrc).toMatch(
      /saveAgentLongPartialSnapshot\("resume_terminal_204"\)/,
    );
    expect(chatComponentSrc).toMatch(
      /getLatestAgentLongAssistantMessageForPartialSave/,
    );
    expect(chatComponentSrc).toMatch(/stop\(\)/);
    expect(chatComponentSrc).toMatch(
      /const finishLocally = \(\) => \{[\s\S]*finalizeNewChatRoute/,
    );
    expect(chatComponentSrc).toMatch(/setIsExistingChat\(true\)/);
  });

  test("client partial-save endpoint is authenticated and assistant-only", () => {
    expect(agentEndpointsSrc).toMatch(
      /AGENT_PARTIAL_SAVE_ENDPOINT\s*=\s*"\/api\/agent\/partial-save"/,
    );
    expect(agentPartialSaveRouteSrc).toMatch(/getUserID\(req\)/);
    expect(agentPartialSaveRouteSrc).toMatch(
      /assertUserCanAccessChatHistory\(userId\)/,
    );
    expect(agentPartialSaveRouteSrc).toMatch(
      /getChatById\(\{\s*id:\s*body\.chatId\s*\}\)/,
    );
    expect(agentPartialSaveRouteSrc).toMatch(/chat\.user_id\s*!==\s*userId/);
    expect(agentPartialSaveRouteSrc).toMatch(
      /message\.role\s*!==\s*"assistant"/,
    );
    expect(agentPartialSaveRouteSrc).toMatch(/hasVisibleAssistantContent/);
    expect(agentPartialSaveRouteSrc).toMatch(/saveMessage\(\{/);
    expect(agentPartialSaveRouteSrc).toMatch(
      /finishReason:\s*CLIENT_SAVED_FINISH_REASON/,
    );
    expect(agentPartialSaveRouteSrc).toMatch(/updateChat\(\{/);
  });

  test("stops the local stream when a streaming chat unmounts", () => {
    expect(chatComponentSrc).toMatch(/const stopRef = useRef\(stop\)/);
    expect(chatComponentSrc).toMatch(/stopActiveBrowserStream/);
    expect(chatComponentSrc).toMatch(
      /const activeChatId = activeChatIdRef\.current;[\s\S]*cancelAgentLongRealtimeStreams\(activeChatId\)/,
    );
    expect(chatComponentSrc).toMatch(
      /statusRef\.current\s*===\s*"streaming"[\s\S]*statusRef\.current\s*===\s*"submitted"[\s\S]*stopRef\.current\(\)/,
    );
    expect(chatComponentSrc).toMatch(
      /return\s*\(\)\s*=>\s*\{\s*stopActiveBrowserStream\(\);[\s\S]*\}/,
    );
  });

  test("new-task reset invalidates stale terminal callbacks before aborting", () => {
    const stopHelperIdx = chatComponentSrc.indexOf(
      "const stopActiveBrowserStream = useCallback(",
    );
    const cancelIdx = chatComponentSrc.indexOf(
      "cancelAgentLongRealtimeStreams(activeChatId)",
      stopHelperIdx,
    );
    const invalidateIdx = chatComponentSrc.indexOf(
      "activeChatIdRef.current = nextChatId",
      stopHelperIdx,
    );
    const abortIdx = chatComponentSrc.indexOf("stopRef.current()", cancelIdx);
    const resetIdx = chatComponentSrc.indexOf("const reset = () => {");
    const nextChatIdIdx = chatComponentSrc.indexOf(
      "const nextChatId = uuidv4()",
      resetIdx,
    );
    const guardedStopIdx = chatComponentSrc.indexOf(
      "stopActiveBrowserStream(nextChatId)",
      nextChatIdIdx,
    );

    expect(stopHelperIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(stopHelperIdx);
    expect(cancelIdx).toBeGreaterThan(invalidateIdx);
    expect(abortIdx).toBeGreaterThan(cancelIdx);
    expect(nextChatIdIdx).toBeGreaterThan(resetIdx);
    expect(guardedStopIdx).toBeGreaterThan(nextChatIdIdx);
    expect(
      chatComponentSrc.match(
        /!isChatMountedRef\.current \|\| activeChatIdRef\.current !== chatId/g,
      ),
    ).toHaveLength(3);
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
    expect(chatComponentSrc).toMatch(/previousOnError[\s\S]*try[\s\S]*catch/);
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
  test("uses the authorized chat snapshot for run and approval session IDs", () => {
    expect(cancelSrc).toMatch(
      /const approvalSessionId\s*=\s*chat\s*\?\s*chat\.active_agent_approval_session_id\s*:\s*temporaryRefresh\?\.approvalSessionId;/,
    );
    expect(cancelSrc).toMatch(
      /const runId\s*=\s*chat\s*\?\s*chat\.active_trigger_run_id\s*:\s*temporaryRefresh\?\.runId/,
    );
    expect(cancelSrc).not.toMatch(/getActiveTriggerRun/);
    expect(cancelSrc).toMatch(/expectedApprovalSessionId:\s*approvalSessionId/);
  });

  test("Trigger cancellation is called before clearing the stored run ID", () => {
    const cancelCallIdx = cancelSrc.indexOf("cancelAgentTriggerRun(runId)");
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
      /NextResponse\.json\(\{[\s\S]*runId,[\s\S]*publicAccessToken,[\s\S]*chatId,[\s\S]*approvalSessionPublicAccessToken/,
    );
  });
});

describe("agent-long task — Trigger.dev dashboard error visibility", () => {
  test("uses /api/agent as the canonical route while keeping /api/agent-long as a compatibility alias", () => {
    expect(agentEndpointsSrc).toMatch(
      /AGENT_API_ENDPOINT\s*=\s*"\/api\/agent"/,
    );
    expect(agentEndpointsSrc).toMatch(
      /AGENT_STATUS_ENDPOINT\s*=\s*"\/api\/agent\/status"/,
    );
    expect(agentEndpointsSrc).toMatch(
      /LEGACY_AGENT_API_ENDPOINT\s*=\s*"\/api\/agent-long"/,
    );
    expect(agentEndpointsSrc).toMatch(
      /LEGACY_AGENT_STATUS_ENDPOINT\s*=\s*"\/api\/agent-long\/status"/,
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
    expect(routeSrc).toMatch(
      /triggerTags\.push\(`permission_\$\{agentPermissionMode\}`\)/,
    );
    expect(routeSrc).toMatch(/const triggerMetadata\s*=\s*{/);
    expect(routeSrc).toMatch(/metadata:\s*triggerMetadata/);
    expect(routeSrc).toMatch(/status:\s*"queued"/);
    expect(routeSrc).toMatch(/loginRequired:\s*false/);
  });

  test("captures Trigger usage and active-time attribution on Agent completion", () => {
    expect(taskSrc).toMatch(/triggerUsage\.getCurrent\(\)/);
    expect(taskSrc).toMatch(
      /triggerUsageDurationMs:\s*currentUsage\.compute\.total\.durationMs/,
    );
    expect(taskSrc).toMatch(
      /triggerTotalCostUsd:\s*currentUsage\.totalCostInCents\s*\/\s*100/,
    );
    expect(taskSrc).toMatch(
      /onApprovalWait:\s*runTimingTracker\.recordApprovalWait/,
    );
    expect(taskSrc).toMatch(
      /onModelStreamStart:\s*runTimingTracker\.startModelStream/,
    );
    expect(taskSrc).toMatch(
      /onModelStreamFinish:\s*runTimingTracker\.finishModelStream/,
    );
    expect(agentStreamRunnerSrc).toMatch(/experimental_onStepStart/);
    expect(agentStreamRunnerSrc).toMatch(/experimental_onToolCallStart/);
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

  test("carries paid daily allowance rescue through the Agent task", () => {
    expect(routeSrc).toMatch(/isLimitRescueRequest\(body\.limitRescue\)/);
    expect(routeSrc).toMatch(/limitRescue,\s*isNewChat/);
    expect(taskSrc).toMatch(/limitRescue\?:\s*LimitRescueRequest/);
    expect(taskSrc).toMatch(/reservePaidDailyFreeAllowanceRequest/);
    expect(taskSrc).toMatch(/getPaidDailyFreeAllowanceModel\(mode\)/);
    expect(taskSrc).toMatch(/createPaidDailyFreeAllowanceBudgetSnapshot/);
    expect(taskSrc).toMatch(/recordPaidDailyFreeAllowanceCost/);
    expect(taskSrc).toMatch(/serializeChatSDKErrorForStream/);
    expect(taskSrc).toMatch(
      /selected_model:\s*selectedModel,\s*response_model:\s*state\.responseModel,/,
    );
    expect(chatHandlerSrc).toMatch(
      /selected_model:\s*selectedModel,\s*response_model:\s*state\.responseModel,/,
    );
  });

  test("uses a turn-scoped Trigger idempotency key for agent runs", () => {
    expect(routeSrc).toMatch(/idempotencyKeys/);
    expect(routeSrc).toMatch(/buildAgentRunDedupeKeyParts/);
    expect(routeSrc).toMatch(/buildAgentRunIdempotencyKey/);
    expect(routeSrc).toMatch(/getLastRequestMessageId/);
    expect(routeSrc).toMatch(/scope:\s*"global"/);
    expect(routeSrc).toMatch(/idempotencyKey:\s*triggerIdempotencyKey/);
    expect(routeSrc).toMatch(/idempotencyKeyTTL:\s*"6h"/);
    expect(routeSrc).toMatch(/existingChat\?\.update_time/);
  });

  test("uses the turn dedupe key for approval session external IDs", () => {
    expect(routeSrc).toMatch(/buildAgentApprovalSessionId/);
    expect(routeSrc).toMatch(/createHash\("sha256"\)/);
    expect(routeSrc).toMatch(/keyParts:\s*triggerDedupeKeyParts/);
    expect(routeSrc).toMatch(
      /approvalProtocolVersion:\s*AGENT_APPROVAL_PROTOCOL_VERSION/,
    );
    expect(routeSrc).toMatch(/approvalWorkerVersion/);
    expect(routeSrc).toMatch(/agentRunRequestId/);
    expect(routeSrc).toMatch(/worker:\$\{approvalWorkerVersion/);
    expect(routeSrc).not.toMatch(/randomUUID/);
  });

  test("agent approval denial resolves as rejected without aborting the run", () => {
    expect(taskSrc).toMatch(/next\.output\.decision\s*===\s*"approve"/);
    expect(taskSrc).toMatch(
      /next\.output\.decision\s*===\s*"approve"[\s\S]*return\s*\{\s*approved:\s*true,\s*approvalId,\s*sandboxIdentity\s*\}/,
    );
    expect(taskSrc).toMatch(
      /tool approval denied[\s\S]*return\s*\{\s*approved:\s*false,[\s\S]*reason:\s*buildDeniedApprovalReason\(next\.output\.message\)/,
    );
    expect(taskSrc).toMatch(/record\.message === undefined/);
    expect(taskSrc).toMatch(
      /The user denied approval for this operation and said:/,
    );

    const denyLogIdx = taskSrc.indexOf("tool approval denied");
    const denyReturnIdx = taskSrc.indexOf("approved: false", denyLogIdx);
    const abortIdx = taskSrc.indexOf("signal.aborted", denyLogIdx);

    expect(denyLogIdx).toBeGreaterThan(-1);
    expect(denyReturnIdx).toBeGreaterThan(denyLogIdx);
    expect(abortIdx === -1 || abortIdx > denyReturnIdx).toBe(true);
  });

  test("agent approval supports target prefix grants for ask-again behavior", () => {
    expect(taskSrc).toMatch(/record\.grant === "target_prefix"/);
    expect(taskSrc).toMatch(/record\.targetPrefix === undefined/);
    expect(taskSrc).toMatch(/record\.targetKind === undefined/);
    expect(taskSrc).toMatch(/const approvedTargetGrants/);
    expect(taskSrc).toMatch(/initialTargetGrants/);
    expect(taskSrc).toMatch(/persistTargetGrant/);
    expect(taskSrc).toMatch(/persistAgentApprovalGrant/);
    expect(taskSrc).toMatch(/agent_approval_grants/);
    expect(taskSrc).toMatch(
      /scopedGrant\.workingDirectory === workingDirectory/,
    );
    expect(taskSrc).toMatch(
      /workingDirectory:\s*projectContext\.workingDirectory/,
    );
    expect(taskSrc).toMatch(
      /approvedTargetGrant\.kind !== "terminal_interaction"/,
    );
    expect(taskSrc).toMatch(/matchesApprovalTargetGrant/);
    expect(taskSrc).toMatch(/approvalStatus", "auto_approved"/);
    expect(taskSrc).toMatch(/next\.output\.grant === "target_prefix"/);
    expect(taskSrc).toMatch(/approvalGrant", "target_prefix"/);
  });

  test("agent approval pending state is durable until the user responds", () => {
    expect(taskSrc).toMatch(/buildPendingApprovalRequest/);
    expect(taskSrc).toMatch(/AgentToolApprovalPendingRequest/);
    expect(taskSrc).toMatch(/operation:\s*request\.operation/);
    expect(taskSrc).toMatch(/request\.justification/);
    expect(taskSrc).toMatch(/request\.prefixRule/);
    expect(taskSrc).toMatch(/let shouldClearApprovalPending = false/);
    expect(taskSrc).toMatch(
      /if\s*\(\s*approvalPendingMarked\s*&&\s*shouldClearApprovalPending\s*\)/,
    );
    expect(taskSrc).toMatch(/shouldClearApprovalPending = true/);
    expect(taskSrc).toMatch(/setApprovalPending\(\s*true,\s*[\s\S]*approvalId/);
  });

  test("agent approval waits without a wall-clock expiry", () => {
    expect(taskSrc).not.toMatch(/AGENT_APPROVAL_TIMEOUT/);
    expect(taskSrc).toMatch(/\.wait<AgentToolApprovalInputRecord>\(\)/);
    expect(taskSrc).toMatch(/activeRuntimeBudget\.pause\(\)/);
    expect(taskSrc).toMatch(/activeRuntimeBudget\.resume\(\)/);
    expect(taskSrc).toMatch(
      /getActiveElapsedTimeMs:\s*runtimeBudget\.getElapsedTimeMs/,
    );
  });

  test("approval tokens are short-lived and refreshable", () => {
    expect(agentApprovalSessionSrc).toMatch(
      /DEFAULT_AGENT_APPROVAL_TOKEN_EXPIRATION\s*=\s*"15m"/,
    );
    expect(agentApprovalSessionSrc).toMatch(
      /process\.env\.AGENT_APPROVAL_TOKEN_EXPIRATION/,
    );
    expect(routeSrc).toMatch(
      /expirationTime:\s*AGENT_APPROVAL_TOKEN_EXPIRATION/,
    );
    expect(resumeSrc).toMatch(
      /expirationTime:\s*AGENT_APPROVAL_TOKEN_EXPIRATION/,
    );
    expect(routeSrc).not.toMatch(/session\.publicAccessToken\s*\?\?/);
    expect(triggerBrowserRealtimeSrc).toMatch(/refreshAccessToken/);
    expect(transportSrc).toMatch(/refreshRunAccessToken/);
    expect(transportSrc).toMatch(/resumeUrl:\s*getAgentResumeUrl\(chatId\)/);
  });

  test("temporary approval refresh is signed, user-bound, and content-free", () => {
    expect(agentApprovalSessionSrc).toMatch(/createHmac\("sha256"/);
    expect(agentApprovalSessionSrc).toMatch(/httpOnly:\s*true/);
    expect(agentApprovalSessionSrc).toMatch(/sameSite:\s*"strict"/);
    expect(resumeSrc).toMatch(/getTemporaryAgentApprovalRefreshHandle/);
    expect(routeSrc).toMatch(/setTemporaryAgentApprovalRefreshCookie/);
    expect(agentApprovalSessionSrc).not.toMatch(/messages|prompt|content/);
  });

  test("approval protocol v2 is explicit and requires route-last deployment", () => {
    expect(agentApprovalSessionSrc).toMatch(
      /AGENT_APPROVAL_PROTOCOL_VERSION\s*=\s*\n?\s*AGENT_TOOL_APPROVAL_PROTOCOL_VERSION/,
    );
    expect(routeSrc).toMatch(
      /approvalProtocolVersion:\s*AGENT_APPROVAL_PROTOCOL_VERSION/,
    );
    expect(routeSrc).toMatch(/Convex -> Trigger worker -> Vercel/);
    expect(routeSrc).toMatch(/old workers ignore this field/);
  });

  test("approval decisions are owner-checked, signed, and appended server-side", () => {
    expect(agentApprovalClientSrc).toMatch(/AGENT_APPROVAL_ENDPOINT/);
    expect(agentApprovalClientSrc).not.toMatch(/sendTriggerSessionInput/);
    expect(agentApprovalRouteSrc).toMatch(/getUserIDAndPro\(req\)/);
    expect(agentApprovalRouteSrc).toMatch(/active_agent_approval_request/);
    expect(agentApprovalRouteSrc).toMatch(
      /getTemporaryAgentApprovalRefreshHandle/,
    );
    expect(agentApprovalRouteSrc).toMatch(
      /metadata\.approvalStatus\s*!==\s*"pending"/,
    );
    expect(agentApprovalRouteSrc).toMatch(/metadata\.approvalToolCallId/);
    expect(agentApprovalRouteSrc).not.toMatch(/streams\.read/);
    expect(taskSrc).toMatch(/\.set\("approvalToolCallId"/);
    expect(taskSrc).toContain('.set("userId", userId)');
    expect(taskSrc).toContain('.set("approvalSessionId", approvalSessionId)');
    expect(taskSrc).toMatch(
      /\.set\(\s*"approvalProtocolVersion",\s*AGENT_TOOL_APPROVAL_PROTOCOL_VERSION/,
    );
    expect(taskSrc).toMatch(/await metadata\.flush\(\)/);
    expect(agentApprovalRouteSrc).toMatch(/signAgentToolApprovalInput/);
    expect(agentApprovalRouteSrc).toMatch(
      /sessions\.open\(approvalSessionId\)\.in\.send\(signedInput/,
    );
  });

  test("approval telemetry keeps correlation context without raw targets", () => {
    const expectedKeysByMessage = {
      "[agent-long] tool approval reused": [
        "event",
        "service",
        "runId",
        "approvalId",
        "tool_call_id",
        "tool_name",
        "operation",
        "target_kind",
      ],
      "[agent-long] waiting for tool approval": [
        "event",
        "service",
        "runId",
        "approvalId",
        "tool_call_id",
        "tool_name",
        "operation",
      ],
      "[agent-long] tool approval granted": [
        "event",
        "service",
        "runId",
        "approvalId",
        "tool_call_id",
        "tool_name",
        "operation",
        "requested_grant",
        "grant",
        "target_kind",
      ],
      "[agent-long] tool approval denied": [
        "event",
        "service",
        "runId",
        "approvalId",
        "tool_call_id",
        "tool_name",
        "operation",
      ],
    } as const;

    for (const [message, expectedKeys] of Object.entries(
      expectedKeysByMessage,
    )) {
      const escapedMessage = message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const payload = new RegExp(
        `triggerLogger\\.info\\("${escapedMessage}",\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\);`,
      ).exec(taskSrc)?.[1];
      expect(payload).toBeDefined();
      const keys = Array.from(
        payload?.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*:|\s*,\s*$)/gm) ??
          [],
        (match) => match[1],
      );
      expect(keys.sort()).toEqual([...expectedKeys].sort());
    }

    expect(taskSrc).not.toContain('.set("approvalTargetPrefix"');
  });

  test("terminal approval cleanup compare-clears stale composer state", () => {
    expect(taskSrc).toMatch(
      /expectedRunId:\s*ctx\.run\.id,[\s\S]*clearApprovalPending:\s*true/,
    );
    expect(resumeSrc).toMatch(
      /expectedRunId:\s*runId,[\s\S]*clearApprovalPending:\s*true/,
    );
    expect(statusSrc).toMatch(/clearTerminalAgentRun/);
    expect(statusSrc).toMatch(/clearApprovalPending:\s*true/);
    expect(chatComponentSrc).toMatch(
      /const storedAgentApprovalRequest\s*=\s*activeTriggerRunId\s*\?\s*getStoredAgentApprovalRequest\(chatDataForCurrentChat\)\s*:\s*null/,
    );
    expect(chatComponentSrc).toMatch(
      /if\s*\(\s*!hasLoadedCurrentChat\s*\|\|\s*activeTriggerRunId\s*\)\s*\{\s*return;\s*\}\s*clearAgentApprovalSession\(\)/,
    );
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
    expect(taskSrc).toMatch(
      /onToolFailure,\s*requestToolApproval,\s*runTimingTracker\.measureActiveTime,\s*projectContext\.workingDirectory,\s*\)/,
    );
  });

  test("direct runs use small subscription-aware Trigger.dev priority offsets", () => {
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
    expect(routeSrc).toMatch(/triggerConfig:\s*approvalTriggerConfig/);
    expect(routeSrc).toMatch(/process\.env\.TRIGGER_VERSION/);
    expect(routeSrc).not.toMatch(/AGENT_APPROVAL_TRIGGER_VERSION/);
    expect(routeSrc).toMatch(/lockToVersion:\s*approvalWorkerVersion/);
    expect(routeSrc).toMatch(
      /shouldRequireAgentApprovalWorkerVersion\(\)[\s\S]*!approvalWorkerVersion[\s\S]*temporarily unavailable/,
    );
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

  test("an unassociated started run is closed and canceled before failing", () => {
    expect(routeSrc).toMatch(/association\s*!==\s*"updated"/);
    expect(routeSrc).toMatch(/agent_run_association:\s*association/);
    expect(routeSrc).toMatch(
      /closeAgentApprovalSession\([\s\S]*"agent-run-association-failed"/,
    );
    expect(routeSrc).toMatch(/cancelAgentTriggerRun\(runId\)/);
  });

  test("start route returns chat id with the public run handle", () => {
    expect(routeSrc).toMatch(
      /NextResponse\.json\(\{[\s\S]*runId,[\s\S]*publicAccessToken,[\s\S]*chatId,[\s\S]*approvalSessionPublicAccessToken/,
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

  test("sanitizes every model stream chunk before the final Trigger realtime pipe", () => {
    const wrapperIdx = taskSrc.indexOf("const withAgentLongStreamHeartbeat");
    const sanitizerIdx = taskSrc.indexOf(
      "sanitizeAgentLongRealtimeChunk(",
      wrapperIdx,
    );
    const mergeIdx = taskSrc.indexOf(
      "writer.merge(\n              withAgentLongStreamHeartbeat(",
      sanitizerIdx,
    );
    const finalPipeIdx = taskSrc.indexOf(
      "agentUiStream.pipe(uiStream)",
      mergeIdx,
    );

    expect(wrapperIdx).toBeGreaterThan(-1);
    expect(sanitizerIdx).toBeGreaterThan(wrapperIdx);
    expect(mergeIdx).toBeGreaterThan(sanitizerIdx);
    expect(finalPipeIdx).toBeGreaterThan(mergeIdx);
  });

  test("both Agent backends route provider finishes through the shared auto-continue helper", () => {
    for (const source of [chatHandlerSrc, taskSrc]) {
      expect(source).toMatch(/getAgentAutoContinueStopSource\(\{/);
      expect(source).toMatch(/finishReason:\s*state\.streamFinishReason/);
      expect(source).toMatch(/writeAutoContinue\(writer\)/);
    }
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

  test("direct context-limit finish reasons trigger auto-continue in both agent paths", () => {
    for (const source of [taskSrc, chatHandlerSrc]) {
      expect(source).toMatch(/getAgentAutoContinueStopSource\(\{/);
      expect(source).toMatch(/autoContinueStopSource/);
      expect(source).toMatch(/agent_auto_continue_signaled/);
    }
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

  test("retry streams reset served-model telemetry and distinguish same-model recovery", () => {
    for (const source of [taskSrc, chatHandlerSrc]) {
      expect(
        source.match(/resetServedModelTelemetryForRetry\(state\)/g),
      ).toHaveLength(2);

      const catchModelSwitchIdx = source.indexOf(
        "retryUsedFallbackModel = retryUsesDifferentModel(",
      );
      const catchResetIdx = source.indexOf(
        "resetServedModelTelemetryForRetry(state)",
        catchModelSwitchIdx,
      );
      const catchRetryStreamIdx = source.indexOf(
        "createStream(fallbackModel)",
        catchResetIdx,
      );

      expect(catchModelSwitchIdx).toBeGreaterThan(-1);
      expect(catchResetIdx).toBeGreaterThan(catchModelSwitchIdx);
      expect(catchRetryStreamIdx).toBeGreaterThan(catchResetIdx);

      const retryModelIdx = source.indexOf(
        "const retryModel = shouldRetryWithoutImageToolResults",
      );
      const modelSwitchIdx = source.indexOf(
        "retryUsedFallbackModel = retryUsesDifferentModel(",
        retryModelIdx,
      );
      const resetIdx = source.indexOf(
        "resetServedModelTelemetryForRetry(state)",
        modelSwitchIdx,
      );
      const retryStreamIdx = source.indexOf(
        "createStream(retryModel)",
        resetIdx,
      );

      expect(modelSwitchIdx).toBeGreaterThan(retryModelIdx);
      expect(resetIdx).toBeGreaterThan(modelSwitchIdx);
      expect(retryStreamIdx).toBeGreaterThan(resetIdx);
    }
  });

  test("assistant-loop abort telemetry uses the multimodal fallback chain", () => {
    const abortStateIdx = agentStreamRunnerSrc.indexOf(
      "const recordAssistantContentLoopAbortState",
    );
    const fallbackTelemetryIdx = agentStreamRunnerSrc.indexOf(
      "state.fallbackServed = resolveFallbackServedTelemetry",
      abortStateIdx,
    );
    const multimodalFallbackIdx = agentStreamRunnerSrc.indexOf(
      "hasMultimodalToolResults: streamHasImageViewResults",
      fallbackTelemetryIdx,
    );

    expect(abortStateIdx).toBeGreaterThan(-1);
    expect(fallbackTelemetryIdx).toBeGreaterThan(abortStateIdx);
    expect(multimodalFallbackIdx).toBeGreaterThan(fallbackTelemetryIdx);
  });

  test("agent stream applies per-step OpenRouter metadata cost before budget checks", () => {
    const onStepFinishIdx = agentStreamRunnerSrc.indexOf(
      "onStepFinish: async ({ usage, response, providerMetadata, content }) => {",
    );
    const accumulateIdx = agentStreamRunnerSrc.indexOf(
      "stepUsageCostIndex = ctx.usageTracker.accumulateStep",
      onStepFinishIdx,
    );
    const extractIdx = agentStreamRunnerSrc.indexOf(
      "const stepOpenRouterMetadata = extractOpenRouterMetadata",
      accumulateIdx,
    );
    const setCostIdx = agentStreamRunnerSrc.indexOf(
      "ctx.usageTracker.setAuthoritativeModelCostForStep(",
      extractIdx,
    );
    const stepIndexArgIdx = agentStreamRunnerSrc.indexOf(
      "stepUsageCostIndex",
      setCostIdx,
    );
    const upstreamCostArgIdx = agentStreamRunnerSrc.indexOf(
      "stepOpenRouterMetadata.openrouter_upstream_inference_cost",
      stepIndexArgIdx,
    );
    const budgetCostIdx = agentStreamRunnerSrc.indexOf(
      "const currentCostDollars = ctx.usageTracker.computeCostDollars(modelName)",
      upstreamCostArgIdx,
    );

    expect(onStepFinishIdx).toBeGreaterThan(-1);
    expect(accumulateIdx).toBeGreaterThan(onStepFinishIdx);
    expect(extractIdx).toBeGreaterThan(accumulateIdx);
    expect(setCostIdx).toBeGreaterThan(extractIdx);
    expect(stepIndexArgIdx).toBeGreaterThan(setCostIdx);
    expect(upstreamCostArgIdx).toBeGreaterThan(stepIndexArgIdx);
    expect(budgetCostIdx).toBeGreaterThan(upstreamCostArgIdx);
  });

  test("agent stream uses finish-step raw usage as OpenRouter metadata cost fallback", () => {
    const finishStepsIdx = agentStreamRunnerSrc.indexOf(
      "const stepOpenRouterMetadatas = Array.isArray(finishMetadata.steps)",
    );
    const mapIdx = agentStreamRunnerSrc.indexOf(
      "? finishMetadata.steps.map((step) => {",
      finishStepsIdx,
    );
    const metadataCostIdx = agentStreamRunnerSrc.indexOf(
      "metadata.openrouter_upstream_inference_cost ??",
      mapIdx,
    );
    const rawFallbackIdx = agentStreamRunnerSrc.indexOf(
      "getOpenRouterUpstreamInferenceCostFromUsageRaw(step.usage?.raw)",
      metadataCostIdx,
    );
    const loopIdx = agentStreamRunnerSrc.indexOf(
      "for (const [index, metadata] of stepOpenRouterMetadatas.entries())",
      rawFallbackIdx,
    );
    const setCostIdx = agentStreamRunnerSrc.indexOf(
      "ctx.usageTracker.setAuthoritativeModelCostForStep(",
      loopIdx,
    );
    const stepIndexArgIdx = agentStreamRunnerSrc.indexOf(
      "stepUsageCostIndexes[index]",
      setCostIdx,
    );
    const upstreamCostArgIdx = agentStreamRunnerSrc.indexOf(
      "metadata.openrouter_upstream_inference_cost",
      stepIndexArgIdx,
    );

    expect(finishStepsIdx).toBeGreaterThan(-1);
    expect(mapIdx).toBeGreaterThan(finishStepsIdx);
    expect(metadataCostIdx).toBeGreaterThan(mapIdx);
    expect(rawFallbackIdx).toBeGreaterThan(metadataCostIdx);
    expect(loopIdx).toBeGreaterThan(rawFallbackIdx);
    expect(setCostIdx).toBeGreaterThan(loopIdx);
    expect(stepIndexArgIdx).toBeGreaterThan(setCostIdx);
    expect(upstreamCostArgIdx).toBeGreaterThan(stepIndexArgIdx);
  });

  test("agent stream reapplies merged final OpenRouter cost metadata to usage and logs", () => {
    const finishMetadataIdx = agentStreamRunnerSrc.indexOf(
      "const finishOpenRouterMetadata = extractOpenRouterMetadata",
    );
    const mergeIdx = agentStreamRunnerSrc.indexOf(
      "const openRouterMetadata = mergeOpenRouterMetadata(",
      finishMetadataIdx,
    );
    const lastStepMetadataIdx = agentStreamRunnerSrc.indexOf(
      "stepOpenRouterMetadatas.at(-1)",
      mergeIdx,
    );
    const setCostIdx = agentStreamRunnerSrc.indexOf(
      "ctx.usageTracker.setAuthoritativeModelCostForStep(",
      lastStepMetadataIdx,
    );
    const lastStepIndexArgIdx = agentStreamRunnerSrc.indexOf(
      "stepUsageCostIndexes.at(-1)",
      setCostIdx,
    );
    const upstreamCostArgIdx = agentStreamRunnerSrc.indexOf(
      "openRouterMetadata.openrouter_upstream_inference_cost",
      lastStepIndexArgIdx,
    );
    const setStreamResponseIdx = agentStreamRunnerSrc.indexOf(
      "ctx.chatLogger?.setStreamResponse(",
      upstreamCostArgIdx,
    );
    const loggedMetadataIdx = agentStreamRunnerSrc.indexOf(
      "openRouterMetadata",
      setStreamResponseIdx,
    );

    expect(finishMetadataIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(finishMetadataIdx);
    expect(lastStepMetadataIdx).toBeGreaterThan(mergeIdx);
    expect(setCostIdx).toBeGreaterThan(lastStepMetadataIdx);
    expect(lastStepIndexArgIdx).toBeGreaterThan(setCostIdx);
    expect(upstreamCostArgIdx).toBeGreaterThan(lastStepIndexArgIdx);
    expect(setStreamResponseIdx).toBeGreaterThan(upstreamCostArgIdx);
    expect(loggedMetadataIdx).toBeGreaterThan(setStreamResponseIdx);
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

  test("invalid provider image URLs are handled as user-correctable input", () => {
    expect(taskSrc).toMatch(/isInvalidImageInputError/);
    expect(taskSrc).toMatch(/"invalid_image_input"/);
    expect(taskSrc).toMatch(
      /USER_CORRECTABLE_AGENT_LONG_ERROR_CATEGORIES[\s\S]*"invalid_image_input"/,
    );
    expect(taskSrc).toMatch(
      /isProviderApiError\(error\)\s*&&\s*!isInvalidImageInputError\(error\)/,
    );
  });

  test("recognizes every observed Trigger S2 terminal signature", () => {
    expect(taskSrc).toMatch(/Connection timeout after \\d\+ms/);
    expect(taskSrc).toMatch(/cs:\[a-z0-9\]\+/);
    expect(taskSrc).toMatch(/Request timeout after \\d\+ms/);
  });

  test("chat metadata failure cannot discard main or fallback generations", () => {
    const finalizationBlockIndexes = [
      ...taskSrc.matchAll(/const generatedTitle = await titlePromise/g),
    ].map((match) => match.index);

    expect(finalizationBlockIndexes).toHaveLength(2);
    for (const finalizationBlockIdx of finalizationBlockIndexes) {
      const updateIdx = taskSrc.indexOf(
        "await updateChat({",
        finalizationBlockIdx,
      );
      const guardedFailureIdx = taskSrc.indexOf(
        "recordAgentLongChatMetadataUpdateFailure(",
        updateIdx,
      );
      const saveMessageIdx = taskSrc.indexOf("await saveMessage({", updateIdx);

      expect(updateIdx).toBeGreaterThan(finalizationBlockIdx);
      expect(guardedFailureIdx).toBeGreaterThan(updateIdx);
      expect(saveMessageIdx).toBeGreaterThan(guardedFailureIdx);
    }
    expect(taskSrc).toMatch(/chatFinalizationStatus/);
  });

  test("generated titles update reactive sidebar data before finalization", () => {
    expect(dbActionsSrc).toMatch(/export async function updateChatTitle/);
    expect(dbActionsSrc).toMatch(/api\.chats\.updateChatTitle/);
    expect(chatHandlerSrc).toMatch(
      /generateTitleFromUserMessageWithWriter\([\s\S]*?\(title\) => updateChatTitle\(\{ chatId, title \}\)/,
    );
    expect(taskSrc).toMatch(
      /generateTitleFromUserMessageWithWriter\([\s\S]*?\(title\) => updateChatTitle\(\{ chatId, title \}\)/,
    );
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

  test("sandbox attachment upload failures are retried and classified separately", () => {
    expect(taskSrc).toMatch(/retryWithFreshSandboxOnTransientFailure:\s*true/);
    expect(chatHandlerSrc).toMatch(
      /retryWithFreshSandboxOnTransientFailure:\s*true/,
    );
    expect(taskSrc).toMatch(/"bad_request:sandbox"/);
    expect(chatHandlerSrc).toMatch(/"bad_request:sandbox"/);
    expect(taskSrc).toMatch(/"sandbox_upload_failure"/);
    expect(taskSrc).toMatch(/upload_failure_kind/);
    expect(taskSrc).toMatch(/isSandboxUploadError/);
    expect(taskSrc).toMatch(/alreadyEmittedFromStream/);
  });

  test("agent-long only passes explicit Trigger.dev region when mapped", () => {
    const userLocationIdx = routeSrc.indexOf(
      "const userLocation = geolocation(req)",
    );
    const routingIdx = routeSrc.indexOf(
      "getTriggerRegionForVercelRequest(req, userLocation)",
      userLocationIdx,
    );
    const triggerOptionsIdx = routeSrc.indexOf(
      "const triggerOptions",
      routingIdx,
    );
    const triggerOptionsRegionIdx = routeSrc.indexOf(
      "...(triggerRegion ? { region: triggerRegion } : {})",
      triggerOptionsIdx,
    );
    const approvalTriggerConfigIdx = routeSrc.indexOf(
      "const approvalTriggerConfig",
      triggerOptionsRegionIdx,
    );
    const sessionRegionIdx = routeSrc.indexOf(
      "...(triggerRegion ? { region: triggerRegion } : {})",
      approvalTriggerConfigIdx,
    );
    const sessionStartIdx = routeSrc.indexOf(
      "sessions.start",
      approvalTriggerConfigIdx,
    );
    const triggerIdx = routeSrc.indexOf(
      "tasks.trigger",
      triggerOptionsRegionIdx,
    );

    expect(userLocationIdx).toBeGreaterThan(-1);
    expect(routingIdx).toBeGreaterThan(-1);
    expect(routingIdx).toBeGreaterThan(userLocationIdx);
    expect(triggerOptionsIdx).toBeGreaterThan(routingIdx);
    expect(triggerOptionsRegionIdx).toBeGreaterThan(triggerOptionsIdx);
    expect(approvalTriggerConfigIdx).toBeGreaterThan(triggerOptionsRegionIdx);
    expect(sessionRegionIdx).toBeGreaterThan(approvalTriggerConfigIdx);
    expect(sessionStartIdx).toBeGreaterThan(sessionRegionIdx);
    expect(triggerIdx).toBeGreaterThan(triggerOptionsRegionIdx);
    expect(triggerIdx).toBeGreaterThan(sessionRegionIdx);
    expect(routeSrc).not.toMatch(/vercelIpContinent|vercelIpCountry/);
    expect(routeSrc).not.toMatch(/trigger region routing/);
  });

  test("agent-long carries free quota subject into Trigger.dev enforcement", () => {
    expect(routeSrc).toMatch(/freeQuotaSubject/);
    expect(routeSrc).toMatch(
      /const agentPayload\s*=\s*{[\s\S]*freeQuotaSubject/,
    );
    expect(routeSrc).toMatch(/tasks\.trigger[\s\S]*agentPayload/);
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
