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
import { streamText, type LanguageModel, type UIMessage } from "ai";
import {
  isTrustedBrowserHandoffReadFailure,
  rethrowBrowserHandoffReadError,
} from "@/lib/ai/browser-handoff/read-error";
import { isProviderApiError } from "@/lib/api/chat-stream-helpers";
import {
  isInvalidImageInputError,
  isProviderContentFilterFinishReason,
  isRetriableProviderStreamDisconnectError,
} from "@/lib/utils/error-utils";
import {
  decideProviderRecovery,
  hasUncertainProviderToolOutcome,
  prepareProviderDisconnectContinuation,
} from "../agent-long-provider-retry";

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

const errorSuppression = (source: ts.SourceFile) => {
  const predicate = only(
    collect(
      source,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) ===
          "createRecoverableProviderErrorFilter",
    ),
    "error suppression",
  ).arguments[0];
  if (!ts.isArrowFunction(predicate) || ts.isBlock(predicate.body))
    throw new Error("error suppression predicate changed shape");
  return compile(source, predicate.body);
};

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

// --- Abliteration error suppression ---------------------------------------

it.each([
  ["Ask", ask],
  ["Agent", agent],
])(
  "%s publishes a local read error instead of hiding it for an Abliteration retry",
  (_name, source) => {
    const hides = errorSuppression(source);
    const scope = (providerError: unknown) => ({
      isRetryWithFallback: false,
      isTrustedBrowserHandoffReadFailure,
      state: { providerError },
      shouldRetryAbliterationError: () => true,
      activeAbliteratedExperiment: {},
      activeModelName: "abliterated",
      userStopSignal: running,
    });
    expect(hides(scope(providerFailures.provider_disconnect))).toBe(true);
    expect(hides(scope(local))).toBe(false);
  },
);

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
