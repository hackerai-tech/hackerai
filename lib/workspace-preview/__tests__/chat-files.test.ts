import { collectChatFiles, mergeSavedFileMessages } from "../chat-files";

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

it("indexes dedicated file_write and file_edit results as distinct versions per environment", () => {
  const snapshot = (environment: string) => ({
    environment,
    identity: `${environment}-machine`,
    capturedAt: 100,
  });
  const files = collectChatFiles([
    {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "tool-file_write",
          state: "output-available",
          toolCallId: "write",
          input: { action: "write", path: "/r/report.md", text: "v1" },
          output: { fileSnapshot: snapshot("cloud") },
        },
        {
          type: "tool-file_write",
          state: "output-available",
          toolCallId: "append",
          input: { action: "append", path: "/r/report.md", text: "+tail" },
          output: { content: "Appended", fileSnapshot: snapshot("cloud") },
        },
        {
          type: "tool-file_edit",
          state: "output-available",
          toolCallId: "edit",
          input: {
            path: "/r/report.md",
            edits: [{ find: "v1", replace: "v2" }],
          },
          output: {
            originalContent: "v1",
            modifiedContent: "v2",
            fileSnapshot: snapshot("desktop"),
          },
        },
        {
          type: "tool-file_edit",
          state: "input-available",
          toolCallId: "pending",
          input: { path: "/r/report.md", edits: [] },
        },
        {
          type: "tool-file_write",
          state: "output-available",
          toolCallId: "failed",
          input: { action: "write", path: "/r/report.md", text: "never" },
          output: { error: "Permission denied" },
        },
        {
          type: "tool-file_edit",
          state: "output-error",
          toolCallId: "errored",
          input: { path: "/r/report.md", edits: [] },
          output: { originalContent: "x", modifiedContent: "y" },
        },
      ],
    },
  ]);
  expect(
    files.map((f) => [f.toolCallId, f.action, f.text, f.source, f.partial]),
  ).toEqual([
    ["write", "write", "v1", "Cloud", false],
    ["append", "append", "+tail", "Cloud", true],
    ["edit", "edit", "v2", "Desktop", false],
  ]);
  expect(files[2].originalText).toBe("v1");
  expect(new Set(files.map((f) => f.id)).size).toBe(3);
});

it("merges older stored files with loaded messages without dropping parts or duplicating files", () => {
  const loaded = [
    result("latest", "cloud", "LATEST"),
    {
      id: "delivery",
      role: "assistant",
      fileDetails: [{ fileId: "zip", name: "loot.zip" }],
    },
  ];
  // Pages arrive newest first; the same message can repeat across pages.
  const merged = mergeSavedFileMessages(loaded, [
    {
      id: "delivery",
      role: "assistant",
      fileDetails: [
        { fileId: "zip", name: "loot.zip" },
        { fileId: "pdf", name: "report.pdf", mediaType: "application/pdf" },
      ],
    },
    { id: "older", role: "assistant", fileDetails: [] },
    {
      id: "oldest",
      role: "assistant",
      fileDetails: [{ fileId: "csv", name: "hosts.csv" }],
    },
    {
      id: "oldest",
      role: "assistant",
      fileDetails: [{ fileId: "csv", name: "hosts.csv" }],
    },
  ]);
  expect(merged.map((m) => m.id)).toEqual([
    "oldest",
    "older",
    "latest",
    "delivery",
  ]);
  expect(merged[2]).toBe(loaded[0]);
  const files = collectChatFiles(merged);
  expect(files.map((f) => f.name)).toEqual([
    "hosts.csv",
    "report.md",
    "loot.zip",
    "report.pdf",
  ]);
  expect(files.find((f) => f.name === "report.pdf")?.saved).toMatchObject({
    fileId: "pdf",
    mediaType: "application/pdf",
  });
  expect(mergeSavedFileMessages(loaded, [])).toBe(loaded);
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
