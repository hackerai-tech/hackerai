import { describe, expect, it } from "@jest/globals";

import {
  resolveSubagentModelForImageToolResults,
  resolveInitialSubagentModel,
  resolveSubagentTriggerPriority,
  SUBAGENT_TEXT_MODEL,
  SUBAGENT_VISION_MODEL,
} from "../model-routing";

describe("subagent model routing", () => {
  it("uses DeepSeek V4 Flash for the default text route", () => {
    expect(SUBAGENT_TEXT_MODEL).toBe("agent-model-free");
    expect(
      resolveSubagentModelForImageToolResults(SUBAGENT_TEXT_MODEL, false),
    ).toBe(SUBAGENT_TEXT_MODEL);
  });

  it("prioritizes browser QA and longer complex children", () => {
    expect(
      resolveSubagentTriggerPriority({
        capabilities: ["browser_qa"],
        complexity: "medium",
        expectedDurationMinutes: 5,
        outputKind: "qa_report",
      }),
    ).toBe(10);
    expect(
      resolveSubagentTriggerPriority({
        capabilities: ["code_read"],
        complexity: "high",
        expectedDurationMinutes: 10,
        outputKind: "answer",
      }),
    ).toBe(5);
    expect(
      resolveSubagentTriggerPriority({
        capabilities: ["web_research"],
        complexity: "low",
        expectedDurationMinutes: 3,
        outputKind: "research_notes",
      }),
    ).toBe(0);
  });

  it("selects the richer route for browser QA and long high-complexity work", () => {
    expect(
      resolveInitialSubagentModel({
        capabilities: ["browser_qa"],
        complexity: "medium",
        expectedDurationMinutes: 5,
        outputKind: "qa_report",
      }),
    ).toBe(SUBAGENT_VISION_MODEL);
    expect(
      resolveInitialSubagentModel({
        capabilities: ["code_read"],
        complexity: "high",
        expectedDurationMinutes: 10,
        outputKind: "answer",
      }),
    ).toBe(SUBAGENT_VISION_MODEL);
    expect(
      resolveInitialSubagentModel({
        capabilities: ["web_research"],
        complexity: "low",
        expectedDurationMinutes: 3,
        outputKind: "research_notes",
      }),
    ).toBe(SUBAGENT_TEXT_MODEL);
  });

  it("promotes to Grok 4.5 when an image tool result appears", () => {
    expect(
      resolveSubagentModelForImageToolResults(SUBAGENT_TEXT_MODEL, true),
    ).toBe(SUBAGENT_VISION_MODEL);
  });

  it("keeps the vision route sticky for later text-only steps", () => {
    expect(
      resolveSubagentModelForImageToolResults(SUBAGENT_VISION_MODEL, false),
    ).toBe(SUBAGENT_VISION_MODEL);
  });
});
