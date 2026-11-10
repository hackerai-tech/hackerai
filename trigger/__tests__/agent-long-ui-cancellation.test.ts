import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createUIMessageStream } from "ai";
import { createAgentUiMessageStream } from "@/lib/chat/agent-ui-message-stream";
import { isCancellationError } from "@/lib/utils/error-utils";
import { ChatSDKError, serializeChatSDKErrorForStream } from "@/lib/errors";

// Exercise the owning factory and actual error callback, replacing only the
// remote execute body so this regression never boots a worker or customer task.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let call: ts.CallExpression | undefined;
/** Locate the actual Agent UI factory, retaining its production error callback. */
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "uiStream" &&
    node.initializer &&
    ts.isCallExpression(node.initializer)
  )
    call = node.initializer;
  ts.forEachChild(node, visit);
}
visit(source);
if (!call || !ts.isObjectLiteralExpression(call.arguments[0]))
  throw new Error("Owning Agent UI factory not found");
const options = ts.factory.updateObjectLiteralExpression(
  call.arguments[0],
  call.arguments[0].properties.map((property) =>
    property.name?.getText(source) === "execute"
      ? ts.factory.createPropertyAssignment(
          "execute",
          ts.factory.createIdentifier("execute"),
        )
      : property,
  ),
);
const actualCall = ts.factory.updateCallExpression(
  call,
  call.expression,
  call.typeArguments,
  [options],
);
const body = ts.transpileModule(
  `let streamError; return ${ts.createPrinter().printNode(ts.EmitHint.Expression, actualCall, source)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

it.each([true, false])(
  "the actual Agent factory publishes matched cancellation as abort and retains unrelated errors (matched=%s)",
  async (matched) => {
    const stop = new AbortController();
    const reason = new Error("controlled Stop");
    stop.abort(reason);
    const failure = matched ? reason : new Error("controlled separate failure");
    const reporting = { fail: jest.fn() };
    const stream = new Function(
      "createUIMessageStream",
      "createAgentUiMessageStream",
      "isCancellationError",
      "userStopSignal",
      "triggerSignal",
      "runReporting",
      "isHandledUserRateLimitError",
      "ChatSDKError",
      "serializeChatSDKErrorForStream",
      "getUserFriendlyProviderError",
      "execute",
      body,
    )(
      createUIMessageStream,
      createAgentUiMessageStream,
      isCancellationError,
      { signal: stop.signal },
      new AbortController().signal,
      reporting,
      () => false,
      ChatSDKError,
      serializeChatSDKErrorForStream,
      () => "controlled visible failure",
      async () => {
        throw failure;
      },
    );
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual(
      matched
        ? [{ type: "abort" }]
        : [{ type: "error", errorText: "controlled visible failure" }],
    );
    if (matched) expect(reporting.fail).not.toHaveBeenCalled();
    else expect(reporting.fail).toHaveBeenCalledWith(failure, "error");
  },
);
