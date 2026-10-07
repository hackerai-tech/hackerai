import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ChatSDKError } from "@/lib/errors";
import { extractErrorDetails } from "@/lib/utils/error-utils";

// Execute the real classifier and terminal recorder without registering a task
// or loading the Agent's model, billing, and sandbox dependencies.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  "MAX_TRIGGER_ERROR_MESSAGE_LENGTH",
  "TRIGGER_TAG_MAX_LENGTH",
  "truncateForTriggerMetadata",
  "sanitizeTriggerTagValue",
  "buildTriggerTag",
  "getStringMetadata",
  "getNumberMetadata",
  "getBooleanMetadata",
  "getPrimitiveMetadata",
  "EMPTY_AFTER_PROCESSING_TRIGGER_METADATA_KEYS",
  "getEmptyAfterProcessingTriggerMetadata",
  "isChatNotFoundError",
  "USER_CORRECTABLE_AGENT_LONG_ERROR_CATEGORIES",
  "isUserCorrectableAgentLongErrorCategory",
  "getAgentLongErrorRunStatus",
  "classifyAgentLongError",
  "GROUPED_PROVIDER_ALERT_CATEGORIES",
  "recordAgentLongFailureForDashboard",
]);
const declarations = source.statements.filter(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) =>
      names.has(declaration.name.getText(source)),
    ),
);
if (declarations.length !== names.size) {
  throw new Error("Agent terminal diagnostic declarations not found");
}
const code = ts.transpileModule(
  `${declarations.map((node) => node.getText(source)).join("\n")}
   return recordAgentLongFailureForDashboard;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

async function recordFailure(error: ChatSDKError, phase = "setup") {
  const metadata = {
    set: jest.fn().mockReturnThis(),
    flush: jest.fn(async () => {}),
  };
  const triggerLogger = { error: jest.fn(), warn: jest.fn() };
  const addAgentLongTags = jest.fn(async () => {});
  const recordGroupedSpikeAlert = jest.fn(async () => {});
  const dependencies = {
    ChatSDKError,
    extractErrorDetails,
    metadata,
    triggerLogger,
    addAgentLongTags,
    recordGroupedSpikeAlert,
  };
  const record = new Function(...Object.keys(dependencies), code)(
    ...Object.values(dependencies),
  );
  const result = await record(error, {
    userId: "user-opaque",
    chatId: "chat-opaque",
    runId: "run-opaque",
    phase,
  });
  expect(result).toEqual({ userCorrectable: false });
  expect(metadata.set).toHaveBeenCalledWith("status", "failed");
  expect(metadata.set).toHaveBeenCalledWith("terminalPhase", phase);
  expect(metadata.flush).toHaveBeenCalledTimes(1);
  expect(triggerLogger.error).toHaveBeenCalledTimes(1);
  expect(triggerLogger.warn).not.toHaveBeenCalled();
  expect(recordGroupedSpikeAlert).not.toHaveBeenCalled();
  return { metadata, triggerLogger };
}

it.each([
  ["acquisition", "setup"],
  ["readiness", "setup"],
  ["transfer", "setup"],
  ["acquisition", "streaming"],
  ["readiness", "streaming"],
  ["transfer", "streaming"],
])(
  "preserves %s attachment phase during %s failure",
  async (phase, terminalPhase) => {
    const error = new ChatSDKError(
      "bad_request:sandbox",
      "Failed to upload 2 attachments to the computer. Please try again.",
      {
        upload_failure_kind: "url",
        upload_failure_phase: phase,
        upload_failure_reason: "unknown",
        upload_retried_after_reconnect: true,
      },
    );
    const { metadata, triggerLogger } = await recordFailure(
      error,
      terminalPhase,
    );
    expect(metadata.set).toHaveBeenCalledWith("uploadFailurePhase", phase);
    expect(metadata.set).toHaveBeenCalledWith(
      "uploadRetriedAfterReconnect",
      true,
    );
    expect(triggerLogger.error).toHaveBeenCalledWith(
      "[agent-long] run failed",
      expect.objectContaining({
        category: "sandbox_upload_failure",
        message: error.message,
        phase: terminalPhase,
        uploadFailurePhase: phase,
        uploadFailureReason: "unknown",
        uploadRetriedAfterReconnect: true,
      }),
    );
  },
);

it.each([undefined, null, "untrusted-private-value", 1, {}, ["transfer"]])(
  "omits unsupported or absent attachment phase %p",
  async (phase) => {
    const error = new ChatSDKError("bad_request:sandbox", "Upload failed", {
      upload_failure_kind: "url",
      upload_failure_phase: phase,
    });
    const { metadata, triggerLogger } = await recordFailure(error);
    expect(metadata.set.mock.calls.map(([key]) => key)).not.toContain(
      "uploadFailurePhase",
    );
    expect(
      triggerLogger.error.mock.calls[0][1].uploadFailurePhase,
    ).toBeUndefined();
    expect(JSON.stringify(triggerLogger.error.mock.calls)).not.toContain(
      "untrusted-private-value",
    );
  },
);

it("keeps metadata-free errors compatible with the terminal recorder", async () => {
  const { metadata } = await recordFailure(
    new ChatSDKError("offline:database", "Database unavailable"),
  );
  expect(metadata.set.mock.calls.map(([key]) => key)).not.toContain(
    "uploadFailurePhase",
  );
});
