import { deserialize, serialize } from "node:v8";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { sourceMessageDigests } from "../model-history";
import { restoreProviderRecoveryContext } from "../provider-recovery-context";

it("preserves the compacted prefix and new completed tools across real SDK reserialization", async () => {
  const source: UIMessage[] = [
    {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "Inspect the fixture" }],
    },
    {
      id: "assistant",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "inspect", state: "done" },
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "before",
          state: "output-available",
          input: { cmd: "first" },
          output: { stdout: "first evidence" },
        },
      ],
    },
  ];
  const original = await convertToModelMessages(source);
  const summary: ModelMessage[] = [
    {
      role: "user",
      content: "<context_summary>First evidence verified</context_summary>",
    },
  ];
  const checkpoint = {
    source: sourceMessageDigests(original),
    messages: summary,
  };
  const resumed = deserialize(serialize(source)) as UIMessage[];
  resumed[1].parts.push(
    { type: "step-start" },
    {
      type: "tool-run_terminal_cmd",
      toolCallId: "after",
      state: "output-available",
      input: { cmd: "second" },
      output: { stdout: "new evidence" },
    },
  );
  resumed.push({
    id: "resume",
    role: "user",
    parts: [{ type: "text", text: "Continue" }],
  });
  const restored = restoreProviderRecoveryContext(
    checkpoint,
    await convertToModelMessages(resumed),
  );
  expect(restored?.[0]).toEqual(summary[0]);
  const text = JSON.stringify(restored);
  expect(text).toContain("new evidence");
  expect(text).toContain("Continue");
  expect(text).not.toContain('"toolCallId":"before"');
  expect(text.match(/"type":"tool-result"/g)).toHaveLength(1);
  expect(source[1].parts).toHaveLength(3);
});

it.each(["edited", "truncated", "different run"])(
  "rejects a checkpoint for %s source history",
  (text) => {
    const checkpoint = {
      source: sourceMessageDigests([{ role: "user", content: "original" }]),
      messages: [{ role: "user", content: "summary" }] as ModelMessage[],
    };
    expect(
      restoreProviderRecoveryContext(
        checkpoint,
        text === "truncated" ? [] : [{ role: "user", content: text }],
      ),
    ).toBeUndefined();
  },
);
