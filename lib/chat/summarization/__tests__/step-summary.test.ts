import { describe, it, expect } from "@jest/globals";
import { MockLanguageModelV3 } from "ai/test";
import {
  findToolResultIndex,
  getAllToolCallIds,
  getLastToolCallId,
  getSecondToLastToolCallId,
  countCompletedToolSteps,
  isStepSummaryMessage,
  buildStepSummaryMessage,
  injectStepSummary,
  generateStepSummaryText,
  extractStepsToSummarize,
  MIN_STEPS_TO_SUMMARIZE,
} from "../step-summary";

const createUserMessage = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

const createAssistantTextMessage = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});

const createAssistantToolCallMessage = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> = {},
) => ({
  role: "assistant" as const,
  content: [
    {
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input,
    },
  ],
});

const createToolResultMessage = (
  toolCallId: string,
  toolName: string,
  output: unknown = "success",
) => ({
  role: "tool" as const,
  content: [
    {
      type: "tool-result" as const,
      toolCallId,
      toolName,
      output,
    },
  ],
});

// user query -> 3 tool call/result pairs
const createStandardMessages = () => [
  createUserMessage("Scan the target"),
  createAssistantToolCallMessage("tc-1", "run_command", {
    command: "nmap -sV target.com",
  }),
  createToolResultMessage("tc-1", "run_command", "PORT 80/tcp open http"),
  createAssistantToolCallMessage("tc-2", "run_command", {
    command: "curl target.com",
  }),
  createToolResultMessage("tc-2", "run_command", "<html>..."),
  createAssistantToolCallMessage("tc-3", "run_command", {
    command: "nikto -h target.com",
  }),
  createToolResultMessage("tc-3", "run_command", "nikto results..."),
];

describe("step-summary", () => {
  describe("findToolResultIndex", () => {
    const messages = createStandardMessages();

    it.each([
      ["tc-1", 2],
      ["tc-2", 4],
      ["tc-3", 6],
      ["nonexistent", -1],
    ])(
      "finds tool result for toolCallId %s at index %d",
      (toolCallId, expected) => {
        expect(findToolResultIndex(messages, toolCallId)).toBe(expected);
      },
    );

    it("returns -1 for empty messages", () => {
      expect(findToolResultIndex([], "tc-1")).toBe(-1);
    });
  });

  describe("getAllToolCallIds", () => {
    it("extracts all toolCallIds in order", () => {
      const messages = createStandardMessages();
      expect(getAllToolCallIds(messages)).toEqual(["tc-1", "tc-2", "tc-3"]);
    });

    it("returns empty array for messages without tool calls", () => {
      const messages = [
        createUserMessage("hello"),
        createAssistantTextMessage("hi"),
      ];
      expect(getAllToolCallIds(messages)).toEqual([]);
    });
  });

  describe("getLastToolCallId", () => {
    it("returns the last toolCallId", () => {
      const messages = createStandardMessages();
      expect(getLastToolCallId(messages)).toBe("tc-3");
    });

    it("returns null for messages without tool calls", () => {
      expect(getLastToolCallId([createUserMessage("hello")])).toBeNull();
    });
  });

  describe("getSecondToLastToolCallId", () => {
    it("returns the second-to-last toolCallId", () => {
      const messages = createStandardMessages();
      expect(getSecondToLastToolCallId(messages)).toBe("tc-2");
    });

    it("returns null when fewer than 2 tool calls", () => {
      const messages = [
        createUserMessage("hello"),
        createAssistantToolCallMessage("tc-1", "run_command"),
        createToolResultMessage("tc-1", "run_command"),
      ];
      expect(getSecondToLastToolCallId(messages)).toBeNull();
    });
  });

  describe("countCompletedToolSteps", () => {
    it("counts completed tool steps (call + result pairs)", () => {
      const messages = createStandardMessages();
      expect(countCompletedToolSteps(messages)).toBe(3);
    });

    it("does not count calls without results", () => {
      const messages = [
        createUserMessage("hello"),
        createAssistantToolCallMessage("tc-1", "run_command"),
        createToolResultMessage("tc-1", "run_command"),
        createAssistantToolCallMessage("tc-2", "run_command"),
      ];
      expect(countCompletedToolSteps(messages)).toBe(1);
    });

    it("returns 0 for messages without tool calls", () => {
      expect(countCompletedToolSteps([createUserMessage("hello")])).toBe(0);
    });
  });

  describe("isStepSummaryMessage", () => {
    it("detects step summary message with content array", () => {
      const msg = buildStepSummaryMessage("test summary");
      expect(isStepSummaryMessage(msg)).toBe(true);
    });

    it("detects step summary message with string content", () => {
      const msg = {
        role: "user" as const,
        content: "<step_summary>\ntest\n</step_summary>",
      };
      expect(isStepSummaryMessage(msg)).toBe(true);
    });

    it("rejects non-summary messages", () => {
      expect(isStepSummaryMessage(createUserMessage("hello"))).toBe(false);
      expect(isStepSummaryMessage(createAssistantTextMessage("hi"))).toBe(
        false,
      );
    });

    it("rejects assistant role even with step_summary content", () => {
      const msg = {
        role: "assistant" as const,
        content: "<step_summary>\ntest\n</step_summary>",
      };
      expect(isStepSummaryMessage(msg)).toBe(false);
    });
  });

  describe("buildStepSummaryMessage", () => {
    it("wraps text in step_summary tags", () => {
      const msg = buildStepSummaryMessage("my summary");
      expect(msg.role).toBe("user");
      expect(Array.isArray(msg.content)).toBe(true);
      const text = (msg.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("<step_summary>");
      expect(text).toContain("my summary");
      expect(text).toContain("</step_summary>");
    });
  });

  describe("injectStepSummary", () => {
    it("replaces tool steps up to cutoff with summary message", () => {
      const messages = createStandardMessages();
      const result = injectStepSummary(messages, "summarized steps", "tc-2");

      expect(result.length).toBe(4);
      expect(result[0].role).toBe("user");
      expect(isStepSummaryMessage(result[1])).toBe(true);
      expect(result[2].role).toBe("assistant");
      expect(result[3].role).toBe("tool");
    });

    it("returns unchanged messages when toolCallId not found", () => {
      const messages = createStandardMessages();
      const result = injectStepSummary(messages, "summary", "nonexistent");
      expect(result).toBe(messages);
    });

    it("preserves context_summary messages before tool steps", () => {
      const messages = [
        createUserMessage(
          "<context_summary>\nPrevious context\n</context_summary>",
        ),
        createUserMessage("Continue scanning"),
        ...createStandardMessages().slice(1),
      ];
      const result = injectStepSummary(messages, "summary", "tc-2");

      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("user");
      expect(isStepSummaryMessage(result[2])).toBe(true);
    });

    it("handles single step cutoff (all steps summarized)", () => {
      const messages = createStandardMessages();
      const result = injectStepSummary(messages, "summary", "tc-3");

      expect(result.length).toBe(2);
      expect(result[0].role).toBe("user");
      expect(isStepSummaryMessage(result[1])).toBe(true);
    });
  });

  describe("extractStepsToSummarize", () => {
    it("extracts steps from first tool call to cutoff", () => {
      const messages = createStandardMessages();
      const steps = extractStepsToSummarize(messages, "tc-2");

      expect(steps.length).toBe(4);
      expect(steps[0].role).toBe("assistant");
      expect(steps[3].role).toBe("tool");
    });

    it("returns empty for nonexistent toolCallId", () => {
      const messages = createStandardMessages();
      expect(extractStepsToSummarize(messages, "nonexistent")).toEqual([]);
    });
  });

  describe("generateStepSummaryText", () => {
    // SDK ModelMessage format uses `input` (not `args`) and structured `output` (not `result`)
    const sdkMessages = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "tc-1",
            toolName: "run_command",
            input: { command: "nmap -sV target.com" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc-1",
            toolName: "run_command",
            output: { type: "text" as const, value: "PORT 80/tcp open http" },
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "tc-2",
            toolName: "run_command",
            input: { command: "curl target.com" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc-2",
            toolName: "run_command",
            output: { type: "text" as const, value: "<html>..." },
          },
        ],
      },
    ];

    // doGenerate receives system prompt in the prompt array as { role: "system", content: string }
    type DoGenerateArgs = {
      prompt: Array<{ role: string; content: string | unknown[] }>;
      abortSignal?: AbortSignal;
    };

    const extractSystemPrompt = (args: DoGenerateArgs): string | undefined => {
      const systemMsg = args.prompt.find((m) => m.role === "system");
      return typeof systemMsg?.content === "string"
        ? systemMsg.content
        : undefined;
    };

    const mockDoGenerate = (
      text: string,
      onCall?: (args: DoGenerateArgs) => void,
    ) => ({
      doGenerate: async (args: DoGenerateArgs) => {
        if (args.abortSignal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        onCall?.(args);
        return {
          content: [{ type: "text" as const, text }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: { inputTokens: 100, outputTokens: 50 },
          request: { body: "" },
          response: {
            id: "test-id",
            timestamp: new Date(),
            modelId: "test-model",
            headers: {},
          },
        };
      },
    });

    it("returns generated text from mock model", async () => {
      const model = new MockLanguageModelV3(
        mockDoGenerate("Generated summary"),
      );
      const result = await generateStepSummaryText(sdkMessages as any, model);
      expect(result).toBe("Generated summary");
    });

    it("passes system prompt with step summarization instructions", async () => {
      let capturedSystem: string | undefined;
      const model = new MockLanguageModelV3(
        mockDoGenerate("summary", (args) => {
          capturedSystem = extractSystemPrompt(args);
        }),
      );

      await generateStepSummaryText(sdkMessages as any, model);

      expect(capturedSystem).toContain("step summarization engine");
    });

    it("includes existing summary for incremental summarization", async () => {
      let capturedSystem: string | undefined;
      const model = new MockLanguageModelV3(
        mockDoGenerate("merged", (args) => {
          capturedSystem = extractSystemPrompt(args);
        }),
      );

      await generateStepSummaryText(
        sdkMessages as any,
        model,
        "Previous step summary",
      );

      expect(capturedSystem).toContain("INCREMENTAL");
      expect(capturedSystem).toContain("Previous step summary");
      expect(capturedSystem).toContain("<previous_step_summary>");
    });

    it("passes abortSignal to generateText", async () => {
      const controller = new AbortController();
      controller.abort();
      const model = new MockLanguageModelV3(mockDoGenerate("summary"));

      await expect(
        generateStepSummaryText(
          sdkMessages as any,
          model,
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow();
    });
  });

  describe("MIN_STEPS_TO_SUMMARIZE", () => {
    it("is at least 2", () => {
      expect(MIN_STEPS_TO_SUMMARIZE).toBeGreaterThanOrEqual(2);
    });
  });
});
