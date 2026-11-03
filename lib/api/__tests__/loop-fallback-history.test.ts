import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { UIMessage } from "ai";
import { markLoopRecoveryCheckpoint } from "@/lib/chat/message-reconciliation";
import {
  AGENT_LOOP_CONTINUATION_PROMPT,
  prepareAgentLoopContinuation,
} from "@/lib/chat/agent-long-provider-retry";
import {
  omitImageViewToolResultsForProviderRetry,
  uiMessagesContainImageViewResult,
} from "@/lib/chat/multimodal-tool-result-recovery";

// Execute each caller's actual history assembly without registering workers,
// contacting a provider, or loading billing and sandbox dependencies.
function recoveryCode(file: string) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.resolve(__dirname, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = new Map<string, string>();
  let loopBody = "";
  let visionCall = "";
  let backgroundSave = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      [
        "loopRecoveryMessages",
        "imageRecovery",
        "loopRecoverySourceMessageId",
      ].includes(node.name.getText(source))
    )
      declarations.set(node.name.getText(source), node.getText(source));
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(source) === "loopContinuation"
    ) {
      loopBody = node.thenStatement.getText(source);
    }
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(source).replace(/\s+/g, " ") ===
        "finishContinuation || loopContinuation || providerDisconnectContinuation"
    )
      backgroundSave = node.getText(source);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) ===
        "describeImageAttachmentsWithAuxiliaryVision" &&
      node.getText(source).includes("loopRecoveryMessages")
    )
      visionCall = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations.size !== 3 || !loopBody || !visionCall) {
    throw new Error(`Missing loop recovery assembly in ${file}`);
  }
  return ts.transpileModule(
    `const ${declarations.get("loopRecoverySourceMessageId")};
     const ${declarations.get("loopRecoveryMessages")};
     const ${declarations.get("imageRecovery")};
     let recoveredVisionMessages;
     if (shouldRetryWithVisionSummary) recoveredVisionMessages = await ${visionCall};
     ${loopBody}
     ${backgroundSave}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
}

it.each([
  ["web", "../chat-handler.ts", false],
  ["web", "../chat-handler.ts", true],
  ["background", "../../../trigger/agent-long.ts", false],
  ["background", "../../../trigger/agent-long.ts", true],
] as const)(
  "%s preserves loop progress in %s when image recovery overlaps (vision=%s)",
  async (_caller, file, vision) => {
    const completed = [
      {
        id: "primary",
        role: "assistant",
        parts: [
          {
            type: "tool-file",
            toolCallId: "view-once",
            state: "output-available",
            input: { action: "view", path: "/tmp/fixture.png" },
            output: {
              action: "view",
              kind: "image",
              mediaType: "image/png",
              data: "synthetic-image",
            },
          },
        ],
      },
    ] as UIMessage[];
    const loopContinuation = prepareAgentLoopContinuation(completed)!;
    const original = [
      {
        id: "request",
        role: "user",
        parts: [
          {
            type: "text",
            text: "Inspect the existing result; never repeat the action.",
          },
          ...(vision
            ? [
                {
                  type: "file",
                  mediaType: "image/png",
                  url: "https://example.invalid/synthetic.png",
                },
              ]
            : []),
        ],
      },
    ] as UIMessage[];
    const state = {
      finalMessages: original,
      providerRejectedMultimodalToolResults: true,
    };
    const saveMessage = jest.fn();
    const describeImageAttachmentsWithAuxiliaryVision = jest.fn(
      async ({ messages }: { messages: UIMessage[] }) =>
        messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) =>
            part.type === "file"
              ? { type: "text" as const, text: "Synthetic image description" }
              : part,
          ),
        })),
    );
    const dependencies = {
      state,
      loopContinuation,
      finishContinuation: undefined,
      providerDisconnectContinuation: undefined,
      retryMessageId: "replacement",
      markLoopRecoveryCheckpoint,
      messages: completed,
      finishedMessages: completed,
      shouldRetryWithVisionSummary: vision,
      shouldRetryWithoutImageToolResults: false,
      omitImageViewToolResultsForProviderRetry,
      describeImageAttachmentsWithAuxiliaryVision,
      generateId: () => "continuation",
      AGENT_LOOP_CONTINUATION_PROMPT,
      usageTracker: { prepareModelRetry: jest.fn() },
      getFileAccumulator: () => ({ getAll: () => [] }),
      observeFinish: (_label: string, action: () => unknown) => action(),
      saveMessage,
      summarizationTracker: {
        processMessageForSave: (message: UIMessage) => message,
      },
      configuredModelId: "primary-model",
      mode: "agent",
      streamStartTime: 0,
      fallbackStartTime: 10,
      chatId: "synthetic-chat",
      userId: "synthetic-user",
      requestId: "synthetic-request",
      ctx: { run: { id: "synthetic-run" } },
      userStopSignal: new AbortController(),
      chatLogger: undefined,
      cacheAuxiliaryVisionDescription: jest.fn(),
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction(...Object.keys(dependencies), recoveryCode(file))(
      ...Object.values(dependencies),
    );
    expect(state.finalMessages.map((message) => message.id)).toEqual([
      "request",
      "primary",
      "continuation",
    ]);
    expect(uiMessagesContainImageViewResult(state.finalMessages)).toBe(false);
    expect(JSON.stringify(state.finalMessages)).not.toContain(
      "synthetic-image",
    );
    expect(state.finalMessages[1].parts).toEqual([
      expect.objectContaining({ toolCallId: "view-once" }),
    ]);
    expect(state.finalMessages[2].metadata).toEqual({ isAutoContinue: true });
    expect(dependencies.usageTracker.prepareModelRetry).toHaveBeenCalledWith({
      isLoopRecovery: true,
    });
    // Provider-only repair must not replace the durable original image result.
    expect(uiMessagesContainImageViewResult(loopContinuation.messages)).toBe(
      true,
    );
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: markLoopRecoveryCheckpoint(
          loopContinuation.messages[0],
          "replacement",
        ),
      }),
    );
    if (vision) {
      expect(describeImageAttachmentsWithAuxiliaryVision).toHaveBeenCalledTimes(
        1,
      );
      expect(state.finalMessages[0].parts).toContainEqual({
        type: "text",
        text: "Synthetic image description",
      });
    }
  },
);
