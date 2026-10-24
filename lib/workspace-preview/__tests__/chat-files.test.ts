import { collectChatFiles } from "../chat-files";

const result = (
  id: string,
  environment: string,
  content: string,
  input = {},
) => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "tool-file",
      state: "output-available",
      toolCallId: `call-${id}`,
      input: { action: "read", path: "/reports/report.md", ...input },
      output: {
        originalContent: content,
        fileSnapshot: {
          environment,
          identity: `${environment}-machine`,
          capturedAt: 100,
        },
      },
    },
  ],
});
it("keeps identical paths from different environments and tool calls as independent versions after reload", () => {
  const history = [
    result("a", "cloud", "CLOUD"),
    result("b", "desktop", "LOCAL"),
  ];
  const files = collectChatFiles(JSON.parse(JSON.stringify(history)));
  expect(files.map((f) => [f.text, f.source, f.sourceId])).toEqual([
    ["CLOUD", "Cloud", "cloud-machine"],
    ["LOCAL", "Desktop", "desktop-machine"],
  ]);
  expect(new Set(files.map((f) => f.id)).size).toBe(2);
});
it("preserves excerpts, empty files, and truncation instead of presenting them as complete downloads", () => {
  const files = collectChatFiles([
    result("range", "cloud", "line", { range: [20, 80] }),
    result("empty", "cloud", ""),
    result(
      "truncated",
      "cloud",
      "head\n[Content truncated due to size limit. Use line ranges to read in chunks]",
    ),
  ]);
  expect(files.map((f) => f.partial)).toEqual([true, false, true]);
  expect(files[0].detail).toBe("Captured lines 20–80");
  expect(files[1].text).toBe("");
});
it("does not fabricate files from failed, pending or missing-content operations", () => {
  const message = result("a", "cloud", "ignored");
  const part = message.parts[0];
  expect(
    collectChatFiles([
      {
        ...message,
        parts: [
          { ...part, state: "input-available" },
          { ...part, output: { error: "failed" } } as any,
          { ...part, output: { content: "too large" } } as any,
        ],
      },
    ]),
  ).toEqual([]);
});
it("retains edit diffs and marks append-only legacy output as partial", () => {
  const message = result("a", "cloud", "ignored");
  const part = message.parts[0];
  const files = collectChatFiles([
    {
      ...message,
      parts: [
        {
          ...part,
          input: { action: "edit", path: "report.md" },
          output: { originalContent: "before", modifiedContent: "after" },
        } as any,
        {
          ...part,
          toolCallId: "append",
          input: { action: "append", path: "report.md", text: "tail" },
          output: { content: "appended" },
        } as any,
      ],
    },
  ]);
  expect(files[0]).toMatchObject({
    text: "after",
    originalText: "before",
    source: "Source not recorded",
  });
  expect(files[1]).toMatchObject({ text: "tail", partial: true });
});
it("indexes stored file IDs without depending on expiring download URLs", () => {
  const files = collectChatFiles([
    {
      id: "message",
      role: "assistant",
      fileDetails: [{ fileId: "saved-id", name: "report.csv" }],
    },
  ]);
  expect(files[0]).toMatchObject({
    saved: { fileId: "saved-id" },
    source: "Saved files",
  });
});

it("does not mistake literal truncation markers in fully written source for an excerpt", () => {
  const message = result("write", "cloud", "");
  message.parts[0].input = {
    action: "write",
    path: "/reports/report.md",
    text: "const items = [...[1, 2]]; // [truncated]",
  } as any;
  expect(collectChatFiles([message])[0]).toMatchObject({
    partial: false,
    text: "const items = [...[1, 2]]; // [truncated]",
  });
});
