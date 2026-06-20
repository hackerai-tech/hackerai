import type { UIMessage } from "ai";
import {
  projectRetainedTailFromMessages,
  selectRetainedTailForSummarization,
} from "../retained-tail";
import { safeCountTokens } from "@/lib/token-utils";

const textMessage = (
  id: string,
  role: "user" | "assistant",
  text: string,
): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe("retained tail selection", () => {
  it("keeps recent whole messages under the token budget", () => {
    const messages = [
      textMessage("msg-1", "user", "old ".repeat(300)),
      textMessage("msg-2", "assistant", "middle"),
      textMessage("msg-3", "user", "latest"),
    ];

    const result = selectRetainedTailForSummarization(messages, {
      budgetTokens: safeCountTokens("middle") + safeCountTokens("latest"),
    });

    expect(result.headMessages.map((message) => message.id)).toEqual(["msg-1"]);
    expect(result.tailMessages.map((message) => message.id)).toEqual([
      "msg-2",
      "msg-3",
    ]);
    expect(result.retainedTail).toMatchObject({
      start_message_id: "msg-2",
      start_part_index: 0,
      strategy: "token_budgeted_tail_v1",
    });
  });

  it("splits a single large assistant message by part index", () => {
    const messages: UIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_terminal_cmd",
            state: "output-available",
            output: "old ".repeat(800),
          } as any,
          {
            type: "tool-run_terminal_cmd",
            state: "output-available",
            output: "middle",
          } as any,
          { type: "text", text: "latest result" },
        ],
      },
    ];

    const result = selectRetainedTailForSummarization(messages, {
      budgetTokens: 20,
    });

    expect(result.cutoffMessageId).toBe("assistant-1");
    expect(result.retainedTail).toMatchObject({
      start_message_id: "assistant-1",
      start_part_index: 1,
    });
    expect(result.headMessages).toHaveLength(1);
    expect(result.headMessages[0].parts).toHaveLength(1);
    expect(result.tailMessages).toHaveLength(1);
    expect(result.tailMessages[0].parts).toHaveLength(2);
  });

  it("projects an oversized latest tool part without storing payload in metadata", () => {
    const hugeOutput = "secret-output ".repeat(10_000);
    const messages: UIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_terminal_cmd",
            input: { command: "cat large.log" },
            state: "output-available",
            output: hugeOutput,
          } as any,
        ],
      },
    ];

    const result = selectRetainedTailForSummarization(messages, {
      budgetTokens: 128,
    });

    expect(result.cutoffMessageId).toBe("assistant-1");
    expect(result.headMessages).toEqual([]);
    expect(result.retainedTail?.projected_part_count).toBe(1);
    expect(JSON.stringify(result.retainedTail)).not.toContain("secret-output");
    expect(JSON.stringify(result.tailMessages)).not.toContain(hugeOutput);
    expect(JSON.stringify(result.tailMessages)).toContain("retained tail");
  });

  it("omits reasoning and status-only parts from the retained tail", () => {
    const messages: UIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" } as any,
          { type: "reasoning", text: "private reasoning" } as any,
          { type: "data-summarization", data: { status: "completed" } } as any,
          { type: "text", text: "visible result" },
        ],
      },
    ];

    const result = selectRetainedTailForSummarization(messages, {
      budgetTokens: 50,
    });

    expect(result.tailMessages[0].parts).toEqual([
      { type: "text", text: "visible result" },
    ]);
  });

  it("reconstructs a persisted tail from start message and part index", () => {
    const messages: UIMessage[] = [
      textMessage("msg-1", "user", "summary-covered"),
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "old part" },
          { type: "text", text: "retained part" },
        ],
      },
      textMessage("msg-3", "user", "new followup"),
    ];

    const projected = projectRetainedTailFromMessages(
      messages,
      {
        start_message_id: "assistant-1",
        start_part_index: 1,
        budget_tokens: 100,
        retained_tokens: 0,
        retained_message_count: 0,
        retained_part_count: 0,
        projected_part_count: 0,
        strategy: "token_budgeted_tail_v1",
      },
      { budgetTokens: 100 },
    );

    expect(projected.map((message) => message.id)).toEqual([
      "assistant-1",
      "msg-3",
    ]);
    expect(projected[0].parts).toEqual([
      { type: "text", text: "retained part" },
    ]);
  });
});
