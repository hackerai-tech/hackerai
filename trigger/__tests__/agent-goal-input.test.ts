import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { UIMessage } from "ai";

// Exercise the worker's actual input-selection block without starting remote
// services, as in agent-long-setup-cancellation.test.ts.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let selection: ts.Statement[] | undefined;
function visit(node: ts.Node) {
  if (ts.isBlock(node)) {
    const start = node.statements.findIndex(
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some(
          (d) => d.name.getText(source) === "messagesForProcessing",
        ),
    );
    const end = node.statements.findIndex(
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some(
          (d) => d.name.getText(source) === "messagesForAccounting",
        ),
    );
    if (start >= 0 && end > start)
      selection = [...node.statements.slice(start, end)];
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!selection) throw new Error("Worker input selection not found");
const select = new Function(
  "localDesktopAttachmentsPrepared",
  "messages",
  "truncatedMessages",
  "goalContinuationMessage",
  ts.transpileModule(
    `${selection.map((s) => s.getText(source)).join("\n")}\nreturn messagesForProcessing;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
) as (
  prepared: boolean,
  payload: UIMessage[],
  persisted: UIMessage[],
  continuation?: UIMessage,
) => UIMessage[];

const continuation: UIMessage = {
  id: "goal-continue:run-2",
  role: "user",
  parts: [{ type: "text", text: "Pursue the updated saved goal" }],
};
const preparedUser: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [
    {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,synthetic",
    },
  ],
};
const assistant: UIMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [{ type: "text", text: "Previous slice" }],
};

it("preserves prepared Desktop attachments and ends with the current continuation turn", () => {
  const payload = [preparedUser, assistant];
  const result = select(true, payload, [assistant, continuation], continuation);
  expect(result).toEqual([preparedUser, assistant, continuation]);
  expect(result[0]).toBe(preparedUser);
  expect(payload).toEqual([preparedUser, assistant]);
});

it("does not duplicate a continuation already fetched from persisted history", () => {
  const persisted = [assistant, continuation];
  expect(select(false, [preparedUser], persisted, continuation)).toBe(
    persisted,
  );
});

it("retains ordinary prepared input and the empty-history fallback", () => {
  const payload = [preparedUser];
  expect(select(true, payload, [assistant])).toBe(payload);
  expect(select(false, payload, [])).toBe(payload);
});
