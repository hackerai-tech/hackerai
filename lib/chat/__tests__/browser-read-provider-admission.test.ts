/**
 * A failed local browser safety read must never be admitted to provider
 * recovery in Ask or Agent, while genuine provider failures keep every
 * existing recovery alternative. The Ask handler and Agent task cannot be
 * booted here (auth, billing, Convex, sandbox and Trigger dependencies), so
 * each actual admission expression is extracted from its owning source and
 * executed with real recovery helpers and errors delivered by the real SDK.
 */
import fs from "node:fs";
import path from "node:path";
import { WritableStream } from "node:stream/web";
import ts from "typescript";
import {
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";
import {
  isTrustedBrowserHandoffReadFailure,
  rethrowBrowserHandoffReadError,
} from "@/lib/ai/browser-handoff/read-error";
import { isProviderApiError } from "@/lib/api/chat-stream-helpers";
import {
  createProviderContentBlockedFinishReasonError,
  isInvalidImageInputError,
  isProviderContentFilterFinishReason,
  isRetriableProviderStreamDisconnectError,
} from "@/lib/utils/error-utils";
import {
  AGENT_FINISH_CONTINUATION_LIMIT_MESSAGE,
  appendAgentFinishContinuationLimit,
  appendProviderEmptyResponseFailure,
  classifyAgentRetryFinalization,
  decideProviderRecovery,
  hasUncertainProviderToolOutcome,
  isTerminalEmptyAssistantResponse,
  prepareProviderDisconnectContinuation,
  PROVIDER_EMPTY_RESPONSE_MESSAGE,
} from "../agent-long-provider-retry";
import { stripAgentLongHeartbeatParts } from "../agent-long-heartbeat";
import { createProviderErrorDeferral } from "../provider-error-stream";

jest.mock("@/lib/db/actions", () => ({ getNotes: jest.fn() }));

const descriptors = ["WritableStream", "structuredClone"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: WritableStream,
  });
  Object.defineProperty(globalThis, "structuredClone", {
    configurable: true,
    value: (v: unknown) => JSON.parse(JSON.stringify(v)),
  });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// --- Actual production expressions ----------------------------------------

const parse = (relative: string) => {
  const file = path.resolve(__dirname, "../../..", relative);
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
};
const ask = parse("lib/api/chat-handler.ts");
const agent = parse("trigger/agent-long.ts");

const collect = <T extends ts.Node>(
  root: ts.Node,
  match: (node: ts.Node) => node is T,
): T[] => {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};
const only = <T>(nodes: T[], label: string): T => {
  if (nodes.length !== 1)
    throw new Error(`${label}: expected one site, found ${nodes.length}`);
  return nodes[0];
};
const declaration = (source: ts.SourceFile, name: string) =>
  only(
    collect(
      source,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && node.name.getText(source) === name,
    ),
    name,
  );

/** Compile an expression; a missing scope name fails as a ReferenceError. */
const compile =
  (source: ts.SourceFile, node: ts.Node) =>
  (scope: Record<string, unknown>): unknown =>
    new Function(
      ...Object.keys(scope),
      ts.transpileModule(`return (${node.getText(source)});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
    )(...Object.values(scope));

const prestreamAdmission = (source: ts.SourceFile) => {
  const attempt = only(
    collect(
      source,
      (node): node is ts.TryStatement =>
        ts.isTryStatement(node) &&
        node.tryBlock.statements.some(
          (statement) =>
            statement.getText(source) ===
            "result = await createStream(selectedModel);",
        ),
    ),
    "prestream attempt",
  );
  return compile(
    source,
    only(
      attempt.catchClause!.block.statements.filter(ts.isIfStatement),
      "prestream admission",
    ).expression,
  );
};

/** Every provider-error deferral's immediate-publication predicate. */
const immediatePublication = (source: ts.SourceFile) =>
  collect(
    source,
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "publishImmediately" &&
      ts.isCallExpression(node.parent.parent) &&
      node.parent.parent.expression.getText(source) ===
        "createProviderErrorDeferral",
  ).map(({ initializer: predicate }) => {
    if (!ts.isArrowFunction(predicate) || ts.isBlock(predicate.body))
      throw new Error("immediate publication predicate changed shape");
    return compile(source, predicate.body);
  });

const askRecovery = only(
  collect(
    ask,
    (node): node is ts.LabeledStatement =>
      ts.isLabeledStatement(node) &&
      node.label.text === "primaryProviderRecovery",
  ),
  "Ask recovery",
).statement;
if (!ts.isIfStatement(askRecovery))
  throw new Error("Ask recovery block changed shape");
const askFinishCondition = compile(ask, askRecovery.expression);

const agentDecision = compile(
  agent,
  only(
    collect(
      agent,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        node.expression.getText(agent) === "decideProviderRecovery",
    ),
    "Agent recovery decision",
  ),
);
const agentFinalContinuation = compile(
  agent,
  declaration(agent, "nextContinuation").initializer!,
);
const isTerminalProviderStreamError = compile(
  agent,
  declaration(agent, "isTerminalProviderStreamError").initializer!,
)({ isProviderContentFilterFinishReason });

// --- Failures delivered through the real SDK ------------------------------

const disconnect = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });

const model = (doStream: jest.Mock): LanguageModel =>
  ({
    specificationVersion: "v3",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doStream,
    doGenerate: jest.fn(),
  }) as LanguageModel;

/** Return the error streamText reports, exactly as Ask and Agent store it. */
const deliver = async (
  mode:
    | "local_read"
    | "local_read_wrapped"
    | "provider_disconnect"
    | "provider_503"
    | "provider_429",
) => {
  const read = Object.freeze(disconnect());
  const doStream = jest.fn(async () => {
    if (mode === "provider_503" || mode === "provider_429")
      throw Object.assign(new Error("Upstream unavailable"), {
        statusCode: mode === "provider_503" ? 503 : 429,
      });
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "error", error: disconnect() });
          controller.close();
        },
      }),
    };
  });
  let observed: unknown;
  const result = streamText({
    model: model(doStream),
    prompt: "fixture",
    maxRetries: 0,
    prepareStep: async () => {
      if (mode === "local_read") rethrowBrowserHandoffReadError(read);
      if (mode === "local_read_wrapped") {
        try {
          rethrowBrowserHandoffReadError(read);
        } catch (error) {
          throw new Error("step preparation failed", { cause: error });
        }
      }
      return undefined;
    },
    onError: ({ error }) => {
      observed = error;
    },
  });
  await result.consumeStream();
  expect(doStream).toHaveBeenCalledTimes(mode.startsWith("local") ? 0 : 1);
  return observed;
};

let local: unknown;
let wrappedLocal: unknown;
let providerFailures: Record<string, unknown>;
beforeAll(async () => {
  local = await deliver("local_read");
  wrappedLocal = await deliver("local_read_wrapped");
  providerFailures = {
    provider_disconnect: await deliver("provider_disconnect"),
    provider_503: await deliver("provider_503"),
    provider_429: await deliver("provider_429"),
  };
});

it("declines an SDK-delivered local read while retaining genuine provider retry eligibility", () => {
  expect(isTrustedBrowserHandoffReadFailure(local)).toBe(true);
  expect(isTrustedBrowserHandoffReadFailure(wrappedLocal)).toBe(true);
  // The shared disconnect predicate declines it too, but that alone cannot
  // fence the Abliteration/generic/empty/media alternatives covered below.
  expect(isRetriableProviderStreamDisconnectError(local)).toBe(false);
  expect(isRetriableProviderStreamDisconnectError(wrappedLocal)).toBe(false);
  for (const failure of [
    providerFailures.provider_disconnect,
    providerFailures.provider_503,
  ])
    expect(isRetriableProviderStreamDisconnectError(failure)).toBe(true);
  for (const failure of Object.values(providerFailures))
    expect(isTrustedBrowserHandoffReadFailure(failure)).toBe(false);
});

class AbliterationVisionError extends Error {}
const running = { signal: new AbortController().signal };
const stopped = (() => {
  const controller = new AbortController();
  controller.abort(new Error("controlled Stop"));
  return { signal: controller.signal };
})();

// --- Ask and Agent before streaming ---------------------------------------

describe.each([
  ["Ask", ask, {}],
  ["Agent", agent, { isInvalidImageInputError }],
] as const)("%s pre-stream fallback admission", (_name, source, extra) => {
  const admits = prestreamAdmission(source);
  const scope = (error: unknown, overrides: Record<string, unknown>) => ({
    isRetryWithFallback: false,
    userStopSignal: running,
    isTrustedBrowserHandoffReadFailure,
    shouldRecoverAbliterationApiError: false,
    isProviderApiError,
    AbliterationVisionError,
    isAutoModel: false,
    shouldRecoverVisionApiError: false,
    ...extra,
    error,
    ...overrides,
  });
  // Same admitted provider-API shape; only read provenance differs.
  const upstream503 = () =>
    Object.assign(new Error("Model is currently at capacity"), {
      statusCode: 503,
    });
  const localRead = () => {
    try {
      rethrowBrowserHandoffReadError(Object.freeze(upstream503()));
    } catch (error) {
      return error;
    }
  };

  it.each([
    ["Abliteration", { shouldRecoverAbliterationApiError: true }],
    ["Auto provider API", { isAutoModel: true }],
    ["vision", { shouldRecoverVisionApiError: true }],
  ])("fences the %s alternative", (_alternative, overrides) => {
    expect(admits(scope(upstream503(), overrides))).toBe(true);
    expect(admits(scope(localRead(), overrides))).toBe(false);
    expect(
      admits(scope(new Error("wrapped", { cause: localRead() }), overrides)),
    ).toBe(false);
  });

  it("keeps Stop and the single retry budget terminal", () => {
    const overrides = { shouldRecoverAbliterationApiError: true };
    expect(
      admits(scope(upstream503(), { ...overrides, userStopSignal: stopped })),
    ).toBe(false);
    expect(
      admits(scope(upstream503(), { ...overrides, isRetryWithFallback: true })),
    ).toBe(false);
  });
});

// --- Provider error deferral never hides a local read ----------------------

/**
 * Publish one SDK attempt through a real deferral whose immediate-publication
 * predicate is a caller's actual expression, reading the state the attempt's
 * onError fills. onFinish then discards, as a scheduled recovery would: only a
 * held error can be hidden that way, so a published error proves it bypassed
 * the deferral.
 */
const publishThroughDeferral = async (
  mode: "local_read" | "provider_disconnect",
  predicate: (scope: Record<string, unknown>) => unknown,
  settlement: "discard" | "release",
) => {
  const state: { providerError: unknown } = { providerError: undefined };
  const deferral = createProviderErrorDeferral({
    publishImmediately: () =>
      Boolean(predicate({ isTrustedBrowserHandoffReadFailure, state })),
  });
  const read = Object.freeze(disconnect());
  const result = streamText({
    model: model(
      jest.fn(async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "error", error: disconnect() });
            controller.close();
          },
        }),
      })),
    ),
    prompt: "fixture",
    maxRetries: 0,
    prepareStep: async () => {
      if (mode === "local_read") rethrowBrowserHandoffReadError(read);
      return undefined;
    },
    onError: ({ error }) => {
      state.providerError = error;
    },
  });
  const published: UIMessageChunk[] = [];
  const reader = result
    .toUIMessageStream({
      onFinish: () => {
        if (settlement === "discard") deferral.discard();
        else deferral.release();
      },
    })
    .pipeThrough(deferral.filter())
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    published.push(value);
  }
  expect(isTrustedBrowserHandoffReadFailure(state.providerError)).toBe(
    mode === "local_read",
  );
  return published.map((chunk) => chunk.type);
};

describe.each([
  ["Ask", ask, 1],
  ["Agent", agent, 2],
] as const)("%s provider error deferral", (_name, source, attempts) => {
  const predicates = immediatePublication(source);

  it("gives every deferred attempt the local read publication predicate", () => {
    expect(predicates).toHaveLength(attempts);
  });

  it("publishes an SDK-delivered local read error that recovery could otherwise hide", async () => {
    for (const predicate of predicates) {
      expect(
        await publishThroughDeferral("local_read", predicate, "discard"),
      ).toContain("error");
    }
  });

  it("still defers a genuine provider error to the recovery decision", async () => {
    for (const predicate of predicates) {
      const recovered = await publishThroughDeferral(
        "provider_disconnect",
        predicate,
        "discard",
      );
      expect(recovered).not.toContain("error");
      expect(recovered).not.toContain("finish");
      expect(recovered).toContain("finish-step");
      expect(
        await publishThroughDeferral(
          "provider_disconnect",
          predicate,
          "release",
        ),
      ).toEqual(expect.arrayContaining(["error", "finish"]));
    }
  });
});

// --- Ask after the stream --------------------------------------------------

describe("Ask onFinish provider recovery admission", () => {
  const scope = (providerError: unknown, alternative: string) => ({
    isTrustedBrowserHandoffReadFailure,
    state: { providerError },
    uncertainToolOutcome: false,
    loopTriggeredRetry: false,
    loopContinuation: undefined,
    shouldRecoverAbliterationStreamError: false,
    shouldRetryWithFallback: false,
    emptyResponseContinuation: undefined,
    shouldRetryWithoutImageToolResults: false,
    shouldRetryWithVisionSummary: false,
    isRetryWithFallback: false,
    [alternative]: alternative === "emptyResponseContinuation" ? {} : true,
  });

  it.each([
    "shouldRecoverAbliterationStreamError",
    "shouldRetryWithFallback",
    "emptyResponseContinuation",
    "shouldRetryWithoutImageToolResults",
    "shouldRetryWithVisionSummary",
  ])("fences the %s alternative", (alternative) => {
    for (const failure of Object.values(providerFailures))
      expect(Boolean(askFinishCondition(scope(failure, alternative)))).toBe(
        true,
      );
    expect(Boolean(askFinishCondition(scope(local, alternative)))).toBe(false);
    expect(Boolean(askFinishCondition(scope(wrappedLocal, alternative)))).toBe(
      false,
    );
  });

  it("keeps uncertain tool outcomes and a used retry terminal", () => {
    const base = scope(
      providerFailures.provider_disconnect,
      "shouldRetryWithFallback",
    );
    expect(
      Boolean(askFinishCondition({ ...base, uncertainToolOutcome: true })),
    ).toBe(false);
    expect(
      Boolean(askFinishCondition({ ...base, isRetryWithFallback: true })),
    ).toBe(false);
  });

  it("selects the retry model only inside the fenced recovery block", () => {
    const retryModel = declaration(ask, "retryModel");
    let ancestor: ts.Node | undefined = retryModel;
    while (ancestor && !ts.isLabeledStatement(ancestor))
      ancestor = ancestor.parent;
    expect((ancestor as ts.LabeledStatement | undefined)?.label.text).toBe(
      "primaryProviderRecovery",
    );
  });
});

// --- Agent after the stream ------------------------------------------------

describe("Agent onFinish provider recovery admission", () => {
  const scope = (
    errors: { streamError?: unknown; providerError?: unknown },
    overrides: Record<string, unknown> = {},
  ) => ({
    decideProviderRecovery,
    isTrustedBrowserHandoffReadFailure,
    AbliterationVisionError,
    userStopSignal: running,
    streamError: errors.streamError,
    state: { providerError: errors.providerError },
    shouldRecoverAbliterationStreamError: false,
    isRetryWithFallback: false,
    isAborted: false,
    stoppedDueToAssistantContentLoop: false,
    confirmedFailureLoop: false,
    uncertainToolOutcome: false,
    loopTriggeredRetry: false,
    loopContinuation: undefined,
    shouldRetryWithFallback: false,
    shouldRetryWithoutImageToolResults: false,
    shouldRetryWithVisionSummary: false,
    finishContinuation: undefined,
    shouldContinueAfterProviderDisconnect: false,
    isAutoModel: false,
    providerContentBlocked: false,
    shouldRetryInterruptedToolInput: false,
    shouldRetryExplicitDeepSeekProReasoning: false,
    ...overrides,
  });
  const decide = (...args: Parameters<typeof scope>) =>
    agentDecision(scope(...args)) as ReturnType<typeof decideProviderRecovery>;

  it.each([
    ["Abliteration", { shouldRecoverAbliterationStreamError: true }],
    ["Auto generic", { shouldRetryWithFallback: true, isAutoModel: true }],
    [
      "disconnect continuation",
      { shouldContinueAfterProviderDisconnect: true },
    ],
    ["image result", { shouldRetryWithoutImageToolResults: true }],
    ["vision summary", { shouldRetryWithVisionSummary: true }],
    ["finish continuation", { finishContinuation: { reason: "x" } }],
  ])("fences the %s alternative", (_alternative, overrides) => {
    for (const failure of Object.values(providerFailures))
      expect(decide({ providerError: failure }, overrides).attempt).toBe(true);
    for (const failure of [local, wrappedLocal])
      expect(decide({ providerError: failure }, overrides)).toEqual({
        attempt: false,
        reason: "no_safe_recovery",
      });
  });

  it("checks the outer stream error and stream state independently", () => {
    const overrides = { shouldContinueAfterProviderDisconnect: true };
    const genuine = providerFailures.provider_503;
    expect(
      decide({ streamError: local, providerError: genuine }, overrides).attempt,
    ).toBe(false);
    expect(
      decide({ streamError: genuine, providerError: local }, overrides).attempt,
    ).toBe(false);
    expect(
      decide({ streamError: genuine, providerError: genuine }, overrides)
        .attempt,
    ).toBe(true);
  });

  it("keeps Stop, used retry and uncertain-tool reasons unchanged", () => {
    const overrides = { shouldRecoverAbliterationStreamError: true };
    expect(
      decide(
        { providerError: local },
        { ...overrides, userStopSignal: stopped },
      ).reason,
    ).toBe("user_cancelled");
    expect(
      decide(
        { providerError: providerFailures.provider_disconnect },
        { ...overrides, isRetryWithFallback: true },
      ).reason,
    ).toBe("retry_budget_exhausted");
    expect(
      decide(
        { providerError: providerFailures.provider_disconnect },
        { ...overrides, uncertainToolOutcome: true },
      ).reason,
    ).toBe("no_safe_recovery");
  });

  it("selects models and ignores Together only after that decision admits recovery", () => {
    expect(
      declaration(agent, "providerRecoveryDecision").initializer!.getText(
        agent,
      ),
    ).toMatch(/^decideProviderRecovery\(/);
    expect(
      declaration(agent, "shouldAttemptProviderRetry").initializer!.getText(
        agent,
      ),
    ).toBe("providerRecoveryDecision.attempt");
    const conjuncts = (expression: ts.Expression): string[] => {
      while (ts.isParenthesizedExpression(expression))
        expression = expression.expression;
      return ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? [...conjuncts(expression.left), ...conjuncts(expression.right)]
        : [expression.getText(agent)];
    };
    const gated = (node: ts.Node) => {
      for (let child = node; child.parent; child = child.parent) {
        const parent = child.parent;
        if (
          ts.isIfStatement(parent) &&
          parent.thenStatement === child &&
          conjuncts(parent.expression).some((term) =>
            ["shouldAttemptProviderRetry", "nextContinuation"].includes(term),
          )
        )
          return true;
      }
      return false;
    };
    const sensitive = [
      ...collect(
        agent,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          node.left.getText(agent) === "streamCtx.ignoredProviderSlugs",
      ),
      declaration(agent, "retryModel"),
    ];
    expect(sensitive.length).toBeGreaterThanOrEqual(3);
    for (const node of sensitive)
      expect([node.getText(agent).slice(0, 40), gated(node)]).toEqual([
        node.getText(agent).slice(0, 40),
        true,
      ]);
  });
});

describe("Agent final Pro/Max disconnect continuation", () => {
  const retryMessages = (): UIMessage[] => [
    {
      id: "retry",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-save",
          toolCallId: "saved-once",
          state: "output-available",
          input: {},
          output: { saved: true },
        },
        { type: "step-start" },
        { type: "text", text: "incomplete", state: "streaming" },
      ],
    } as UIMessage,
  ];
  const continuation = (
    errors: { streamError?: unknown; providerError?: unknown },
    overrides: Record<string, unknown> = {},
  ) =>
    agentFinalContinuation({
      isTrustedBrowserHandoffReadFailure,
      isTerminalProviderStreamError,
      isRetriableProviderStreamDisconnectError,
      hasUncertainProviderToolOutcome,
      prepareProviderDisconnectContinuation,
      streamError: errors.streamError,
      state: { providerError: errors.providerError },
      normalizedRetryMessages: retryMessages(),
      retryAborted: false,
      selectedModelOverride: "hackerai-max",
      ...overrides,
    }) as ReturnType<typeof prepareProviderDisconnectContinuation>;

  it.each(["hackerai-max", undefined])(
    "admits a genuine disconnect but not a local read (override %s)",
    (selectedModelOverride) => {
      const genuine = continuation(
        { providerError: providerFailures.provider_disconnect },
        { selectedModelOverride },
      );
      expect(genuine?.preservedCompletedToolCount).toBe(1);
      for (const failure of [local, wrappedLocal])
        expect(
          continuation({ providerError: failure }, { selectedModelOverride }),
        ).toBeUndefined();
      expect(
        continuation(
          {
            streamError: local,
            providerError: providerFailures.provider_disconnect,
          },
          { selectedModelOverride },
        ),
      ).toBeUndefined();
    },
  );

  it("keeps Stop terminal for a genuine disconnect", () => {
    expect(
      continuation(
        { providerError: providerFailures.provider_disconnect },
        { retryAborted: true },
      ),
    ).toBeUndefined();
  });
});

// --- Ask final outcome and its logging branch ------------------------------

/**
 * The actual statements of one Ask settlement: from its finish-reason check
 * through the first success/error logging branch after `outcome`. Analytics
 * capture is left out; the compiled body returns `outcome` instead.
 */
const askSettlement = (outcomeGuard: string, firstDeclared: string) => {
  const outcome = only(
    collect(
      ask,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(ask) === "outcome" &&
        new RegExp(`^${outcomeGuard}\\s*\\?`).test(
          node.initializer?.getText(ask) ?? "",
        ),
    ),
    `${outcomeGuard} outcome`,
  ).parent.parent as ts.VariableStatement;
  const statements = (outcome.parent as ts.Block).statements;
  const at = statements.indexOf(outcome);
  const from = statements.findIndex(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declared) => declared.name.getText(ask) === firstDeclared,
      ),
  );
  const to = statements.findIndex(
    (statement, index) => index > at && ts.isIfStatement(statement),
  );
  if (from < 0 || from > at || to < 0)
    throw new Error(`${outcomeGuard} settlement changed shape`);
  const body = statements
    .slice(from, to + 1)
    .filter(
      (statement) =>
        !statement.getText(ask).startsWith("captureAgentCompletionAnalytics("),
    )
    .map((statement) => statement.getText(ask))
    .join("\n");
  return ts.transpileModule(`${body}\nreturn outcome;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
};

type UiRunMode =
  | "local"
  | "local_wrapped"
  | "local_after_tool"
  // A completed tool step whose provider finish reason is "stop": the SDK still
  // runs another step, so Ask/Agent later see stale "stop" and tool-only parts.
  | "local_after_tool_stop"
  | "empty_after_tool_stop"
  | "provider_disconnect"
  | "success";

/**
 * Run the real SDK through its UI message stream and record Ask's stream state
 * the way the shared runner does: its onError stores the error, and only the
 * SDK onFinish sets the finish reason. `priorFinishReason` is state left from
 * before this attempt, which a failed step must not be mistaken for.
 */
const runThroughUi = async (mode: UiRunMode, priorFinishReason?: string) => {
  const read = Object.freeze(disconnect());
  const state: { providerError: unknown; streamFinishReason?: string } = {
    providerError: undefined,
    streamFinishReason: priorFinishReason,
  };
  const record: {
    modelCalls: number;
    sdkFinishCalled: boolean;
    ui?: { isAborted: boolean };
  } = { modelCalls: 0, sdkFinishCalled: false };
  let messages: UIMessage[] = [];
  const parts = (...chunks: unknown[]) => ({
    stream: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
  });
  const finish = (reason: string) => ({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  });
  const doStream = jest.fn(async () => {
    record.modelCalls++;
    if (mode === "provider_disconnect")
      return parts({ type: "error", error: disconnect() });
    const toolStep = (reason: string) =>
      parts(
        {
          type: "tool-call",
          toolCallId: "saved-once",
          toolName: "save",
          input: "{}",
        },
        finish(reason),
      );
    if (mode === "local_after_tool") return toolStep("tool-calls");
    if (mode === "local_after_tool_stop") return toolStep("stop");
    if (mode === "empty_after_tool_stop")
      return record.modelCalls === 1 ? toolStep("stop") : parts(finish("stop"));
    return parts(
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "Done." },
      { type: "text-end", id: "answer" },
      finish("stop"),
    );
  });
  const result = streamText({
    model: model(doStream),
    prompt: "fixture",
    tools: {
      save: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
    },
    stopWhen: stepCountIs(3),
    maxRetries: 0,
    prepareStep: async ({ stepNumber }) => {
      const failingStep =
        mode === "local" || mode === "local_wrapped"
          ? 0
          : mode === "local_after_tool" || mode === "local_after_tool_stop"
            ? 1
            : -1;
      if (stepNumber !== failingStep) return undefined;
      if (mode === "local_wrapped") {
        try {
          rethrowBrowserHandoffReadError(read);
        } catch (error) {
          throw new Error("step preparation failed", { cause: error });
        }
      }
      rethrowBrowserHandoffReadError(read);
    },
    onError: ({ error }) => {
      state.providerError = error;
    },
    onFinish: ({ finishReason }) => {
      record.sdkFinishCalled = true;
      state.streamFinishReason = finishReason;
    },
  });
  let chunks = 0;
  for await (const message of readUIMessageStream({
    stream: result.toUIMessageStream({
      generateMessageId: () => "assistant",
      onFinish: ({ isAborted, messages: finished }) => {
        record.ui = { isAborted };
        messages = finished;
      },
    }),
    onError: () => {},
  }))
    chunks += message ? 1 : 0;
  return { state, record, read, chunks, messages };
};

const askLegs = {
  // Primary leg: Stop normally clears the finish reason before settlement.
  primary: askSettlement("isAborted", "finalProviderContentBlocked"),
  // Fallback leg: a genuine provider failure was admitted and the fallback's
  // own safety read then failed; Stop keeps the finish reason here.
  fallback: askSettlement("retryAborted", "providerContentBlocked"),
};
type AskLeg = keyof typeof askLegs;

/** Execute one leg's actual settlement statements against observed state. */
const settleAsk = (
  leg: AskLeg,
  providerError: unknown,
  streamFinishReason: string | undefined,
  aborted = false,
  emptyResponse = false,
) => {
  const chatLogger = {
    emitUnexpectedError: jest.fn(),
    emitSuccess: jest.fn(),
  };
  const scope = {
    state: { providerError, streamFinishReason },
    isProviderContentFilterFinishReason,
    isTrustedBrowserHandoffReadFailure,
    createProviderContentBlockedFinishReasonError,
    isAborted: leg === "primary" && aborted,
    retryAborted: leg === "fallback" && aborted,
    visionSummaryRecoveryFailure: undefined,
    terminalEmptyResponse: leg === "primary" && emptyResponse,
    retryEmptyResponse: leg === "fallback" && emptyResponse,
    isPreemptiveAbort: false,
    summarizationTracker: { hasSummarized: false },
    chatLogger,
  };
  const outcome = new Function(...Object.keys(scope), askLegs[leg])(
    ...Object.values(scope),
  );
  return { outcome, chatLogger };
};

describe.each(["primary", "fallback"] as const)(
  "Ask %s outcome after a local read",
  (leg) => {
    const settle = (
      providerError: unknown,
      streamFinishReason: string | undefined,
      aborted = false,
    ) => settleAsk(leg, providerError, streamFinishReason, aborted);

    // [case, mode, state before the attempt, provider calls, SDK onFinish,
    //  finish reason Ask observes]. None is "error": a first-step failure never
    // reaches the SDK onFinish, and a later one reports the completed step's.
    it.each([
      ["a first-step", "local", undefined, 0, false, undefined],
      ["a wrapped first-step", "local_wrapped", undefined, 0, false, undefined],
      ["a stale-reason first-step", "local", "stop", 0, false, "stop"],
      ["a post-tool", "local_after_tool", undefined, 1, true, "tool-calls"],
    ] as const)(
      "reports %s local read delivered by the SDK UI stream as an error",
      async (
        _kind,
        mode,
        priorFinishReason,
        modelCalls,
        sdkFinishCalled,
        observedFinishReason,
      ) => {
        const { state, record, read } = await runThroughUi(
          mode,
          priorFinishReason,
        );
        // No provider call for the failed step and a non-aborted UI finish.
        expect(record).toEqual({
          modelCalls,
          sdkFinishCalled,
          ui: { isAborted: false },
        });
        expect(state.streamFinishReason).toBe(observedFinishReason);
        expect(isTrustedBrowserHandoffReadFailure(state.providerError)).toBe(
          true,
        );
        if (mode !== "local_wrapped") expect(state.providerError).toBe(read);

        const { outcome, chatLogger } = settle(
          state.providerError,
          state.streamFinishReason,
          record.ui!.isAborted,
        );
        expect(outcome).toBe("error");
        expect(chatLogger.emitSuccess).not.toHaveBeenCalled();
        expect(chatLogger.emitUnexpectedError).toHaveBeenCalledTimes(1);
        expect(chatLogger.emitUnexpectedError.mock.calls[0][0]).toBe(
          state.providerError,
        );
      },
    );

    it.each([
      ["an ordinary answer", "success"],
      ["a genuine provider disconnect", "provider_disconnect"],
    ] as const)(
      "keeps %s from the SDK UI stream on its existing accounting",
      async (_kind, mode) => {
        const { state, record } = await runThroughUi(mode);
        expect(record.modelCalls).toBe(1);
        expect(isTrustedBrowserHandoffReadFailure(state.providerError)).toBe(
          false,
        );
        const { outcome, chatLogger } = settle(
          state.providerError,
          state.streamFinishReason,
          record.ui!.isAborted,
        );
        expect(outcome).toBe("success");
        expect(chatLogger.emitUnexpectedError).not.toHaveBeenCalled();
        expect(chatLogger.emitSuccess).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps Stop, ordinary success, content filters and other provider errors unchanged", () => {
      // Stop takes precedence whether or not the finish reason was cleared.
      for (const finishReason of [undefined, "error"]) {
        const stopped = settle(local, finishReason, true);
        expect(stopped.outcome).toBe("aborted");
        expect(stopped.chatLogger.emitUnexpectedError).not.toHaveBeenCalled();
        expect(stopped.chatLogger.emitSuccess).toHaveBeenCalledWith(
          expect.objectContaining({ wasAborted: true }),
        );
      }

      const ordinary = settle(undefined, "stop");
      expect(ordinary.outcome).toBe("success");
      expect(ordinary.chatLogger.emitSuccess).toHaveBeenCalledTimes(1);

      const filtered = settle(undefined, "content-filter");
      expect(filtered.outcome).toBe("error");
      expect(filtered.chatLogger.emitUnexpectedError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ProviderContentBlockedFinishReasonError",
        }),
      );

      // Out of scope here: other terminal provider errors keep their existing
      // accounting rather than being widened by this local-read correction.
      const genuine = settle(providerFailures.provider_503, "error");
      expect(genuine.outcome).toBe("success");
      expect(genuine.chatLogger.emitUnexpectedError).not.toHaveBeenCalled();
    });
  },
);

// --- Provider empty-answer synthesis before settlement ---------------------

/**
 * One site's actual statements: the declarations it reads (wherever they sit
 * in the owning callback) followed by the `if` that may synthesize a provider
 * empty answer or a finish-continuation limit.
 */
const synthesisSite = (
  source: ts.SourceFile,
  declared: string[],
  isSiteIf: (condition: string) => boolean,
) => {
  const declarations = declared.map((name) =>
    declaration(source, name).parent.parent.getText(source),
  );
  const site = only(
    collect(
      source,
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && isSiteIf(node.expression.getText(source)),
    ),
    `synthesis ${declared.join(",")}`,
  );
  const code = ts.transpileModule(
    [...declarations, site.getText(source)].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return (scope: Record<string, unknown>) =>
    new Function(...Object.keys(scope), code)(...Object.values(scope));
};

const synthesisSites = {
  "Ask primary": synthesisSite(ask, ["terminalEmptyResponse"], (condition) =>
    condition.startsWith("terminalEmptyResponse &&"),
  ),
  "Ask fallback": synthesisSite(
    ask,
    ["retryAssistant", "retryEmptyResponse"],
    (condition) => condition === "retryEmptyResponse",
  ),
  "Agent primary": synthesisSite(
    agent,
    ["terminalEmptyResponse"],
    (condition) => condition.startsWith("terminalEmptyResponse &&"),
  ),
  "Agent fallback": synthesisSite(
    agent,
    ["finalization"],
    (condition) => condition === 'finalization === "finish_continuation_limit"',
  ),
};
type SynthesisSite = keyof typeof synthesisSites;

const synthesize = (
  site: SynthesisSite,
  run: Awaited<ReturnType<typeof runThroughUi>>,
  { aborted = false, finishContinuationAttempted = false } = {},
) => {
  const writer = { write: jest.fn() };
  const messages = run.messages;
  const lastAssistantMessageParts =
    messages.findLast((message) => message.role === "assistant")?.parts ?? [];
  // Ask primary settles with its earlier, pre-synthesis empty-answer flag.
  const terminalEmptyResponse = isTerminalEmptyAssistantResponse(
    lastAssistantMessageParts,
    run.state.streamFinishReason,
  );
  synthesisSites[site]({
    isTrustedBrowserHandoffReadFailure,
    isTerminalEmptyAssistantResponse,
    appendProviderEmptyResponseFailure,
    classifyAgentRetryFinalization,
    appendAgentFinishContinuationLimit,
    stripAgentLongHeartbeatParts,
    state: run.state,
    writer,
    userStopSignal: running,
    isAborted: aborted,
    retryAborted: aborted,
    visionQaError: undefined,
    finishContinuationAttempted,
    lastAssistantMessageParts,
    messages,
    finishedMessages: messages,
    retryMessages: messages,
    assistantMessageId: "assistant",
    retryMessageId: "assistant",
  });
  const text = JSON.stringify(messages);
  const appendedEmpty = text.includes(PROVIDER_EMPTY_RESPONSE_MESSAGE);
  return {
    writer,
    appendedEmpty,
    appendedLimit: text.includes(
      JSON.stringify(AGENT_FINISH_CONTINUATION_LIMIT_MESSAGE).slice(1, -1),
    ),
    // Ask fallback settles with its site's own retryEmptyResponse.
    emptyResponse:
      site === "Ask primary" ? terminalEmptyResponse : appendedEmpty,
  };
};

/** Ask settles the synthesized state; Agent's existing outcome is its error state. */
const outcomeAfter = (
  site: SynthesisSite,
  run: Awaited<ReturnType<typeof runThroughUi>>,
  emptyResponse: boolean,
  aborted = false,
) => {
  if (site.startsWith("Ask"))
    return settleAsk(
      site === "Ask primary" ? "primary" : "fallback",
      run.state.providerError,
      run.state.streamFinishReason,
      aborted,
      emptyResponse,
    );
  return {
    outcome: aborted
      ? "aborted"
      : isTerminalProviderStreamError(run.state)
        ? "error"
        : "success",
  };
};

describe.each(Object.keys(synthesisSites) as SynthesisSite[])(
  "%s empty-answer synthesis",
  (site) => {
    const continuationAttempts =
      site === "Agent fallback" ? [false, true] : [false];

    it.each(continuationAttempts)(
      "keeps a local read after a stale-stop tool step as the terminal error (continuation attempted: %s)",
      async (finishContinuationAttempted) => {
        const run = await runThroughUi("local_after_tool_stop");
        // The hazard the SDK actually produces: a completed tool step finished
        // "stop", the next prepareStep failed, and only tool parts remain.
        expect(run.record).toEqual({
          modelCalls: 1,
          sdkFinishCalled: true,
          ui: { isAborted: false },
        });
        expect(run.state.streamFinishReason).toBe("stop");
        expect(run.state.providerError).toBe(run.read);
        const parts = run.messages.at(-1)?.parts ?? [];
        expect(isTerminalEmptyAssistantResponse(parts, "stop")).toBe(true);
        const before = JSON.stringify(run.messages);

        const result = synthesize(site, run, { finishContinuationAttempted });
        expect(run.state.providerError).toBe(run.read);
        expect(run.state.streamFinishReason).toBe("stop");
        expect(result.writer.write).not.toHaveBeenCalled();
        expect(JSON.stringify(run.messages)).toBe(before);

        const settled = outcomeAfter(site, run, result.emptyResponse);
        expect(settled.outcome).toBe("error");
        if ("chatLogger" in settled) {
          expect(settled.chatLogger.emitSuccess).not.toHaveBeenCalled();
          expect(settled.chatLogger.emitUnexpectedError.mock.calls).toEqual([
            [run.read],
          ]);
        }
      },
    );

    it.each(continuationAttempts)(
      "keeps the existing diagnosis for an ordinary empty answer (continuation attempted: %s)",
      async (finishContinuationAttempted) => {
        const run = await runThroughUi("empty_after_tool_stop");
        expect(run.record.modelCalls).toBe(2);
        expect(run.state).toEqual({
          providerError: undefined,
          streamFinishReason: "stop",
        });
        const result = synthesize(site, run, { finishContinuationAttempted });
        if (finishContinuationAttempted) {
          // Agent's genuine bounded finish still reports its limit.
          expect(result.appendedLimit).toBe(true);
          expect(run.state.providerError).toBeUndefined();
          return;
        }
        expect(result.appendedEmpty).toBe(true);
        expect(run.state.streamFinishReason).toBe("error");
        expect(run.state.providerError).toEqual(
          new Error("Provider completed without a usable answer"),
        );
        expect(outcomeAfter(site, run, result.emptyResponse).outcome).toBe(
          "error",
        );
      },
    );

    it("leaves a stopped empty answer to the existing Stop path", async () => {
      const run = await runThroughUi("empty_after_tool_stop");
      const result = synthesize(site, run, { aborted: true });
      expect(result.writer.write).not.toHaveBeenCalled();
      expect(run.state.providerError).toBeUndefined();
      expect(outcomeAfter(site, run, result.emptyResponse, true).outcome).toBe(
        "aborted",
      );
    });
  },
);

// --- Agent goal completion judging during final usage settlement ----------

describe("Agent final usage settlement with an active goal", () => {
  // The whole actual helper shared by the primary, fallback and final legs.
  // External I/O is stubbed; the free-plan branch is the settlement exercised.
  const deductAccumulatedUsage = compile(
    agent,
    declaration(agent, "deductAccumulatedUsage").initializer!,
  );

  const settle = (state: object, signal = running) => {
    const getGoal = jest.fn(async () => ({
      activeRunId: "run",
      state: "running",
    }));
    const judgeGoalCompletion = jest.fn(async () => ({
      verdict: "done",
      reason: "Criteria met.",
    }));
    const recordFreeMonthlyCost = jest.fn(async () => undefined);
    const releaseFreeRunLockOnce = jest.fn(async () => undefined);
    const noop = () => undefined;
    const run = deductAccumulatedUsage({
      hasRecordedUsage: false,
      goalJudgePromise: undefined,
      goalJudgment: undefined,
      activeGoal: { id: "goal" },
      userStopSignal: signal,
      isTrustedBrowserHandoffReadFailure,
      state,
      getGoal,
      judgeGoalCompletion,
      chatId: "chat",
      userId: "user",
      ctx: { run: { id: "run" } },
      chatLogger: undefined,
      goalFinalMessages: [],
      goalFinalMessageId: "assistant",
      goalRunMessageIds: new Set(["assistant"]),
      messagesForAccounting: [],
      titlePromise: Promise.resolve(),
      getSandboxSessionUsage: async () => ({ totalCostDollars: 0 }),
      getTriggerRunUsage: () => ({ totalCostDollars: 0 }),
      getQaDiscardedRetryCostDollars: () => 0,
      checkQaProviderCapacity: undefined,
      usageTracker: {
        providerCost: 0,
        nonModelCost: 0,
        hasUsage: true,
        usageSettlementId: "settlement",
        createUsageCostRecord: () => ({ costDollars: 0.01 }),
        measurementProperties: () => ({}),
      },
      paidDailyFreeAllowanceReservation: undefined,
      subscription: "free",
      recordFreeMonthlyCost,
      freeUsageSubject: "user",
      resolveServedModelForCostAccounting: () => "model",
      runReporting: { captureCost: jest.fn() },
      captureUsageCost: noop,
      usageSettlementState: null,
      usageSettlementSequence: 0,
      localConnectionLost: () => false,
      releaseFreeRunLockOnce,
      selectedModel: "model",
      selectedModelOverride: undefined,
      configuredModelId: "model",
      activeModelName: "model",
      mode: "agent",
      rateLimitInfo: {},
      posthog: undefined,
      organizationId: undefined,
      endpoint: "/api/agent",
      agentPermissionMode: undefined,
      analyticsRequestContext: undefined,
      routingExperimentContext: undefined,
    }) as () => Promise<void>;
    return {
      run,
      getGoal,
      judgeGoalCompletion,
      recordFreeMonthlyCost,
      releaseFreeRunLockOnce,
    };
  };

  it.each([
    ["a stale-stop tool step", "local_after_tool_stop", undefined, "stop"],
    ["a tool-calls step", "local_after_tool", undefined, "tool-calls"],
    // Stale-state fixture: a reason already in state before the first step.
    ["a wrapped first step", "local_wrapped", "stop", "stop"],
    ["a first step", "local", undefined, undefined],
  ] as const)(
    "does not judge a goal after a local read following %s, but still settles once",
    async (_kind, mode, priorFinishReason, finishReason) => {
      const { state } = await runThroughUi(mode, priorFinishReason);
      expect(state.streamFinishReason).toBe(finishReason);
      expect(isTrustedBrowserHandoffReadFailure(state.providerError)).toBe(
        true,
      );
      const settlement = settle(state);
      await settlement.run();
      await settlement.run();
      expect(settlement.getGoal).not.toHaveBeenCalled();
      expect(settlement.judgeGoalCompletion).not.toHaveBeenCalled();
      expect(settlement.recordFreeMonthlyCost).toHaveBeenCalledTimes(1);
      expect(settlement.releaseFreeRunLockOnce).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["an ordinary answer", "success"],
    ["an ordinary empty answer after tools", "empty_after_tool_stop"],
  ] as const)("still judges %s once and settles once", async (_kind, mode) => {
    const { state } = await runThroughUi(mode);
    expect(state.streamFinishReason).toBe("stop");
    const settlement = settle(state);
    await settlement.run();
    await settlement.run();
    expect(settlement.getGoal).toHaveBeenCalledTimes(1);
    expect(settlement.judgeGoalCompletion).toHaveBeenCalledTimes(1);
    expect(settlement.recordFreeMonthlyCost).toHaveBeenCalledTimes(1);
  });

  it("still judges an unmarked provider error under the same stale stop", async () => {
    // Stale-state fixture: a genuine SDK-delivered provider failure left with
    // a previous "stop"; only trusted local reads lose judging admission.
    const settlement = settle({
      providerError: providerFailures.provider_disconnect,
      streamFinishReason: "stop",
    });
    await settlement.run();
    expect(settlement.getGoal).toHaveBeenCalledTimes(1);
    expect(settlement.judgeGoalCompletion).toHaveBeenCalledTimes(1);
    expect(settlement.recordFreeMonthlyCost).toHaveBeenCalledTimes(1);
  });

  it("does not judge after Stop but still settles", async () => {
    const { state } = await runThroughUi("success");
    const settlement = settle(state, stopped);
    await settlement.run();
    expect(settlement.judgeGoalCompletion).not.toHaveBeenCalled();
    expect(settlement.recordFreeMonthlyCost).toHaveBeenCalledTimes(1);
  });
});
