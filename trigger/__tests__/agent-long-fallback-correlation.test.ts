import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { extractErrorDetails } from "@/lib/utils/error-utils";

const mockCaptureException = jest.fn();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({ captureException: mockCaptureException }),
}));
jest.mock("@/lib/posthog/logs", () => ({
  emitPostHogLog: jest.fn(() => true),
  flushPostHogLogs: jest.fn(),
}));
const { phLogger } = require("@/lib/posthog/server");

// Execute the actual fallback producer through the capture boundary without
// registering the task or loading its model, sandbox, and billing dependencies.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "phLogger.error" &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text ===
      "[agent-long] Provider API error, retrying with fallback"
  ) {
    calls.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (calls.length !== 1) throw new Error("Agent fallback producer not found");
const code = ts.transpileModule(calls[0].getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

it.each(["run-first", "run-second"])(
  "correlates the fallback exception with its owning Trigger run %s",
  (runId) => {
    mockCaptureException.mockClear();
    const error = new Error("Provider temporarily unavailable");
    const dependencies = {
      phLogger,
      ctx: { run: { id: runId } },
      error,
      chatId: "chat-distinct-from-run",
      selectedModel: "original-model",
      configuredModelId: "original-provider-model",
      apiRetryModel: "fallback-model",
      trackedProvider: {
        languageModel: () => ({ modelId: "fallback-provider-model" }),
      },
      userId: "user-opaque",
      subscription: "pro",
      usageTracker: { cacheReadTokens: 123, cacheWriteTokens: 456 },
      extractErrorDetails,
    };
    new Function(...Object.keys(dependencies), code)(
      ...Object.values(dependencies),
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      "user-opaque",
      expect.objectContaining({
        event: "agent_long_provider_api_error_retrying_with_fallback",
        request_id: runId,
        trigger_run_id: runId,
        chatId: "chat-distinct-from-run",
        originalModel: "original-model",
        fallbackModel: "fallback-model",
        preFallbackCacheReadTokens: 123,
        preFallbackCacheWriteTokens: 456,
      }),
    );
  },
);
