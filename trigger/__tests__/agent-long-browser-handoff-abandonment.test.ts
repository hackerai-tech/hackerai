/**
 * The worker's own stop wiring and finalization statements for an abandoned
 * parent browser handoff, executed without booting Trigger or remote services.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createAgentStopSignal } from "@/lib/chat/agent-stop-signal";
import { LocalConnectionLostError } from "@/lib/chat/local-connection-stop";
import {
  BrowserHandoffAbandonedError,
  manualAgentResumeFinishReason,
} from "@/lib/chat/manual-agent-resume";
import { getAgentAutoContinueStopSource } from "@/lib/chat/stop-conditions";
import { resolveGoalOutcome } from "@/lib/goals/contracts";
import { getResumeSection } from "@/lib/system-prompt/resume";

const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const text = (node: ts.Node) => node.getText(source);
const declares = (statement: ts.Statement, name: string) =>
  ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.some((d) => text(d.name) === name);

let stopSetup: ts.Statement[] | undefined;
let abandonCallback: ts.Expression | undefined;
let goalCanceled: ts.Expression | undefined;
const finalizations: Record<string, ts.Statement[]> = {};
function visit(node: ts.Node) {
  if (ts.isBlock(node)) {
    const statements = [...node.statements];
    const start = statements.findIndex((s) =>
      declares(s, "terminalAgentState"),
    );
    const end = statements.findIndex(
      (s) =>
        ts.isIfStatement(s) && text(s.expression) === "triggerSignal.aborted",
    );
    if (start >= 0 && end > start) stopSetup = statements.slice(start, end + 1);
    // Main and retry finalization: first stop check through billing settlement.
    for (const marker of ["finalManualResume", "manualResume"]) {
      const from = statements.findIndex((s) => declares(s, marker));
      const to = statements.findIndex((s) => declares(s, "outcome"));
      if (from >= 0 && to > from)
        finalizations[marker] = statements.slice(from, to);
    }
  }
  if (
    ts.isPropertyAssignment(node) &&
    text(node.name) === "onBrowserHandoffAbandoned"
  )
    abandonCallback = node.initializer;
  if (
    ts.isCallExpression(node) &&
    text(node.expression) === "finishGoalRun" &&
    ts.isObjectLiteralExpression(node.arguments[2])
  ) {
    const canceled = node.arguments[2].properties.find(
      (p) => p.name && text(p.name) === "canceled",
    );
    if (canceled && ts.isPropertyAssignment(canceled))
      goalCanceled = canceled.initializer;
  }
  ts.forEachChild(node, visit);
}
visit(source);

const compile = (body: string, names: string[]) =>
  new Function(
    ...names,
    ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );

/** The worker's actual stop setup plus its actual abandonment callback. */
function startRun() {
  if (!stopSetup || !abandonCallback)
    throw new Error("Agent stop wiring not found");
  const trigger = new AbortController();
  const setup = compile(
    `${stopSetup.map(text).join("\n")}
     return { userStopSignal, stopSignal, manualResumeFinishReason };`,
    [
      "createAgentStopSignal",
      "triggerSignal",
      "triggerLogger",
      "ctx",
      "chatId",
      "LocalConnectionLostError",
      "manualAgentResumeFinishReason",
    ],
  )(
    createAgentStopSignal,
    trigger.signal,
    { warn: jest.fn() },
    { run: { id: "run-test" } },
    "chat-test",
    LocalConnectionLostError,
    manualAgentResumeFinishReason,
  );
  const onAbandoned = compile(`return (${text(abandonCallback)});`, [
    "stopSignal",
    "BrowserHandoffAbandonedError",
  ])(setup.stopSignal, BrowserHandoffAbandonedError) as () => void;
  return { ...setup, trigger, onAbandoned };
}

/** Run one finalization's stop check, settlement and restore with stubs. */
async function finalize(
  marker: "finalManualResume" | "manualResume",
  run: ReturnType<typeof startRun>,
) {
  const statements = finalizations[marker];
  if (!statements) throw new Error(`${marker} finalization not found`);
  const aborted = marker === "manualResume" ? "retryAborted" : "isAborted";
  const state = { streamFinishReason: "stop" as string | undefined };
  const deductAccumulatedUsage = jest.fn(async () => {
    // Final billing reconciliation can find a usage limit at the same time.
    state.streamFinishReason = "budget-exhausted";
  });
  const dependencies = {
    manualResumeFinishReason: run.manualResumeFinishReason,
    userStopSignal: run.userStopSignal,
    triggerSignal: run.trigger.signal,
    state,
    deductAccumulatedUsage,
    drainBackgroundRunWork: jest.fn(async () => undefined),
    terminalEmptyResponse: false,
    isTrustedBrowserHandoffReadFailure: () => false,
    appendProviderEmptyResponseFailure: jest.fn(),
    classifyAgentRetryFinalization: () => undefined,
    appendAgentFinishContinuationLimit: jest.fn(),
    stripAgentLongHeartbeatParts: (message: unknown) => message,
    finishContinuationAttempted: false,
    retryMessages: [],
    retryMessageId: "retry",
    finishedMessages: [],
    assistantMessageId: "assistant",
    writer: { write: jest.fn() },
    sandboxManager: { getSandboxInfo: () => null },
    chatLogger: undefined,
    usageTracker: {
      cacheHitRate: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    preFallbackCacheRead: 0,
    preFallbackCacheWrite: 0,
    captureToolCalls: jest.fn(),
    posthog: undefined,
    userId: "user-test",
    mode: "agent",
    ctx: { run: { id: "run-test" } },
  };
  const result = await compile(
    `return (async () => {
       let ${aborted} = false;
       ${statements.map(text).join("\n")}
       return ${aborted};
     })();`,
    Object.keys(dependencies),
  )(...Object.values(dependencies));
  return { aborted: result as boolean, state, deductAccumulatedUsage };
}

const goalCanceledFor = (
  run: ReturnType<typeof startRun>,
  terminalAgentState: Record<string, boolean>,
) => {
  if (!goalCanceled) throw new Error("Goal settlement not found");
  return compile(`return (${text(goalCanceled)});`, [
    "manualResumeFinishReason",
    "triggerSignal",
    "userStopSignal",
    "terminalAgentState",
  ])(
    run.manualResumeFinishReason,
    run.trigger.signal,
    run.userStopSignal,
    terminalAgentState,
  ) as boolean;
};

describe("a committed parent handoff abandonment in the worker", () => {
  it.each(["finalManualResume", "manualResume"] as const)(
    "saves %s progress as an aborted, resumable stop after billing settles",
    async (marker) => {
      const run = startRun();
      run.onAbandoned();
      expect(run.stopSignal.source).toBe("browser_handoff_abandoned");
      expect(run.userStopSignal.signal.reason).toBeInstanceOf(
        BrowserHandoffAbandonedError,
      );
      const result = await finalize(marker, run);
      expect(result.deductAccumulatedUsage).toHaveBeenCalledTimes(1);
      expect(result.aborted).toBe(true);
      // A concurrent usage-limit reason cannot replace the manual boundary.
      expect(result.state.streamFinishReason).toBe("browser-handoff-abandoned");
      expect(
        getAgentAutoContinueStopSource({
          finishReason: result.state.streamFinishReason,
          stoppedDueToTokenExhaustion: true,
          stoppedDueToPostSummarizationIncomplete: true,
        }),
      ).toBeNull();
      run.stopSignal.dispose();
    },
  );

  it("pauses an active Goal through its existing settlement", () => {
    const run = startRun();
    run.onAbandoned();
    const canceled = goalCanceledFor(run, {
      stoppedDueToBudgetExhaustion: true,
    });
    expect(canceled).toBe(true);
    expect(
      resolveGoalOutcome({
        canceled,
        failed: false,
        usageExhausted: false,
        noProgressRuns: 0,
        allCriteriaVerified: false,
        finishReason: "browser-handoff-abandoned",
      }),
    ).toBe("paused");
    run.stopSignal.dispose();
  });

  it.each([
    [
      "a user Stop",
      (run: ReturnType<typeof startRun>) => run.trigger.abort("stop"),
    ],
    [
      "a usage stop",
      (run: ReturnType<typeof startRun>) =>
        run.stopSignal.abort("usage_settlement_uncovered"),
    ],
  ])("keeps an earlier %s authoritative", async (_name, stopFirst) => {
    const run = startRun();
    stopFirst(run);
    const earlier = run.userStopSignal.signal.reason;
    run.onAbandoned();
    expect(run.userStopSignal.signal.reason).toBe(earlier);
    expect(run.manualResumeFinishReason()).toBeUndefined();
    const result = await finalize("finalManualResume", run);
    expect(result.state.streamFinishReason).toBe("budget-exhausted");
    run.stopSignal.dispose();
  });

  it("asks a manual resume to inspect saved and current state before repeating work", () => {
    const section = getResumeSection("browser-handoff-abandoned");
    expect(section).toMatch(/inspect the current state/i);
    expect(section).toMatch(/without repeating completed work/i);
    expect(section).toMatch(/request a new handoff and wait for the user/i);
  });
});
