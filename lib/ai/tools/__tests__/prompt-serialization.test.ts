import { convertToModelMessages, type ToolSet, type UIMessage } from "ai";
import type { ToolContext } from "@/types";
import {
  createPromptSerializationTools,
  type PromptFormatterFailure,
} from "../prompt-serialization";

jest.mock("@/lib/db/actions", () => ({
  createNote: jest.fn(),
  listNotes: jest.fn(),
  listNoteSummaries: jest.fn(),
  getNoteContent: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));

const { getNoteContent: mockGetNoteContent } = jest.requireMock<{
  getNoteContent: jest.Mock;
}>("@/lib/db/actions");
const { createGetNote } = require("../notes") as typeof import("../notes");

const historyWithToolOutput = (
  toolName: string,
  output: unknown,
): UIMessage[] =>
  [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: `tool-${toolName}`,
          toolCallId: "call-secret-id",
          state: "output-available",
          input: { note_id: "note-secret-id" },
          output,
        },
      ],
    },
  ] as UIMessage[];

describe("createPromptSerializationTools", () => {
  it("serializes historical file view outputs without calling the live file tool", async () => {
    const liveFileToModelOutput = jest.fn(() => {
      throw new Error("live file serializer should not run for history");
    });
    const tools = createPromptSerializationTools({
      file: { toModelOutput: liveFileToModelOutput },
    } as unknown as ToolSet);
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-file",
            toolCallId: "call-1",
            state: "output-available",
            input: { action: "view", path: "/tmp/private.png" },
            output: {
              action: "view",
              content: "Viewing image file: private.png (image/png, 68 bytes).",
              path: "/tmp/private.png",
              filename: "private.png",
              mediaType: "image/png",
              sizeBytes: 68,
              kind: "image",
            },
          },
        ],
      },
    ] as UIMessage[];

    const result = await convertToModelMessages(messages, { tools });

    expect(liveFileToModelOutput).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "file",
            input: { action: "view", path: "/tmp/private.png" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "file",
            output: {
              type: "text",
              value: "Viewing image file: private.png (image/png, 68 bytes).",
            },
          },
        ],
      },
    ]);
  });

  it("preserves non-file tool serializers for provider-compatible history", async () => {
    const openUrlToModelOutput = jest.fn(({ output }) => ({
      type: "text" as const,
      value: `serialized:${String(output)}`,
    }));
    const tools = createPromptSerializationTools({
      open_url: { toModelOutput: openUrlToModelOutput },
    } as unknown as ToolSet);
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-open_url",
            toolCallId: "call-1",
            state: "output-available",
            input: { url: "https://example.com" },
            output: "tool result",
          },
        ],
      },
    ] as UIMessage[];

    const result = await convertToModelMessages(messages, { tools });

    expect(openUrlToModelOutput).toHaveBeenCalledWith({
      toolCallId: "call-1",
      input: { url: "https://example.com" },
      output: "tool result",
    });
    expect(result[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          output: { type: "text", value: "serialized:tool result" },
        },
      ],
    });
  });

  describe("with a formatter failure observer", () => {
    it("reports a synchronous get_note rejection by shape and rethrows the original error", async () => {
      const onFormatterFailure = jest.fn();
      const tools = createPromptSerializationTools(
        { get_note: createGetNote({} as ToolContext) } as unknown as ToolSet,
        { onFormatterFailure },
      );
      const history = historyWithToolOutput("get_note", {
        success: true,
        message: "private note text",
        __hackeraiStorageCompacted: true,
      });

      await expect(convertToModelMessages(history, { tools })).rejects.toThrow(
        new TypeError(
          "Cannot read properties of undefined (reading 'note_id')",
        ),
      );
      expect(mockGetNoteContent).not.toHaveBeenCalled();
      expect(onFormatterFailure).toHaveBeenCalledTimes(1);
      expect(onFormatterFailure).toHaveBeenCalledWith({
        tool: "get_note",
        rejection: "sync",
        output_kind: "object",
        note_kind: "missing",
        notes_kind: "missing",
        success: "true",
        storage_compacted: true,
      } satisfies PromptFormatterFailure);
    });

    it("reports an asynchronous rejection and rejects with the same error object", async () => {
      const failure = new Error("formatter failed for note-secret-id");
      const execute = jest.fn();
      const onFormatterFailure = jest.fn();
      const tools = createPromptSerializationTools(
        {
          list_notes: {
            execute,
            toModelOutput: async () => {
              throw failure;
            },
          },
        } as unknown as ToolSet,
        { onFormatterFailure },
      );

      await expect(
        convertToModelMessages(
          historyWithToolOutput("list_notes", {
            success: false,
            notes: [{ note_id: "note-secret-id" }],
          }),
          { tools },
        ),
      ).rejects.toBe(failure);
      expect(execute).not.toHaveBeenCalled();
      expect(onFormatterFailure).toHaveBeenCalledWith({
        tool: "list_notes",
        rejection: "async",
        output_kind: "object",
        note_kind: "missing",
        notes_kind: "array",
        success: "false",
        storage_compacted: false,
      } satisfies PromptFormatterFailure);
    });

    it("rethrows the original synchronous error when the observer itself throws", async () => {
      const failure = new Error("original");
      const tools = createPromptSerializationTools(
        {
          get_note: {
            toModelOutput: () => {
              throw failure;
            },
          },
        } as unknown as ToolSet,
        {
          onFormatterFailure: () => {
            throw new Error("telemetry unavailable");
          },
        },
      );

      await expect(
        convertToModelMessages(historyWithToolOutput("get_note", {}), {
          tools,
        }),
      ).rejects.toBe(failure);
    });

    it("buckets dynamic tool names and never invokes output getters or proxy traps", async () => {
      const failure = new Error("original");
      const throwingFormatter = () => {
        throw failure;
      };
      const noteGetter = jest.fn(() => ({ note_id: "note-secret-id" }));
      const { proxy: revokedOutput, revoke } = Proxy.revocable({}, {});
      revoke();
      const failures: PromptFormatterFailure[] = [];
      const tools = createPromptSerializationTools(
        {
          mcp_private_server_tool: { toModelOutput: throwingFormatter },
          get_note: { toModelOutput: throwingFormatter },
        } as unknown as ToolSet,
        { onFormatterFailure: (observed) => failures.push(observed) },
      );
      const accessorOutput = { success: "yes" };
      Object.defineProperty(accessorOutput, "note", {
        enumerable: true,
        get: noteGetter,
      });

      await expect(
        convertToModelMessages(
          historyWithToolOutput("mcp_private_server_tool", accessorOutput),
          { tools },
        ),
      ).rejects.toBe(failure);
      await expect(
        convertToModelMessages(
          historyWithToolOutput("get_note", revokedOutput),
          { tools },
        ),
      ).rejects.toBe(failure);

      expect(noteGetter).not.toHaveBeenCalled();
      expect(failures).toEqual([
        {
          tool: "other",
          rejection: "sync",
          output_kind: "object",
          note_kind: "accessor",
          notes_kind: "missing",
          success: "other",
          storage_compacted: false,
        },
        {
          tool: "get_note",
          rejection: "sync",
          output_kind: "unreadable",
          note_kind: "unreadable",
          notes_kind: "unreadable",
          success: "other",
          storage_compacted: false,
        },
      ]);
    });

    it("keeps successful output, file history safety, receiver and synchronous results unchanged", async () => {
      const liveFileToModelOutput = jest.fn();
      const openUrlToModelOutput = jest.fn(function (
        this: { label: string },
        { output }: { output: unknown },
      ) {
        return { type: "text" as const, value: `${this.label}:${output}` };
      });
      const liveTools = {
        file: { toModelOutput: liveFileToModelOutput },
        open_url: { label: "serialized", toModelOutput: openUrlToModelOutput },
      } as unknown as ToolSet;
      const onFormatterFailure = jest.fn();
      const observedTools = createPromptSerializationTools(liveTools, {
        onFormatterFailure,
      });
      const history = [
        ...historyWithToolOutput("open_url", "tool result"),
        ...historyWithToolOutput("file", {
          action: "view",
          content: "Viewing image file: private.png",
          path: "/tmp/private.png",
        }),
      ];

      const observed = await convertToModelMessages(history, {
        tools: observedTools,
      });

      expect(observed).toEqual(
        await convertToModelMessages(history, {
          tools: createPromptSerializationTools(liveTools),
        }),
      );
      expect(observed[3]).toMatchObject({
        content: [
          {
            output: {
              type: "text",
              value: "Viewing image file: private.png",
            },
          },
        ],
      });
      expect(observed[1]).toMatchObject({
        content: [
          { output: { type: "text", value: "serialized:tool result" } },
        ],
      });
      expect(openUrlToModelOutput).toHaveBeenCalledWith({
        toolCallId: "call-secret-id",
        input: { note_id: "note-secret-id" },
        output: "tool result",
      });
      expect(liveFileToModelOutput).not.toHaveBeenCalled();
      expect(onFormatterFailure).not.toHaveBeenCalled();
      expect(
        observedTools.open_url.toModelOutput!({
          toolCallId: "call-1",
          input: {},
          output: "direct",
        }),
      ).toEqual({ type: "text", value: "serialized:direct" });
    });

    it("does not turn a successful formatter return into a prototype-check failure", () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      const onFormatterFailure = jest.fn();
      const tools = createPromptSerializationTools(
        { get_note: { toModelOutput: () => proxy } } as unknown as ToolSet,
        { onFormatterFailure },
      );
      expect(
        tools.get_note.toModelOutput!({
          toolCallId: "call",
          input: {},
          output: {},
        }),
      ).toBe(proxy);
      expect(onFormatterFailure).not.toHaveBeenCalled();
    });
  });
});
