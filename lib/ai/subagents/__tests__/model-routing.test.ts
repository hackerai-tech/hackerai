import { describe, expect, it } from "@jest/globals";

import {
  resolveSubagentModelForImageToolResults,
  resolveInitialSubagentModel,
  resolveSubagentTextModel,
  resolveSubagentTriggerPriority,
  SUBAGENT_FREE_TEXT_MODEL,
  SUBAGENT_PAID_TEXT_MODEL,
  SUBAGENT_VISION_MODEL,
} from "../model-routing";

describe("subagent model routing", () => {
  it("uses DeepSeek for free and paid text work", () => {
    expect(resolveSubagentTextModel("free")).toBe(SUBAGENT_FREE_TEXT_MODEL);
    expect(resolveSubagentTextModel("pro")).toBe(SUBAGENT_PAID_TEXT_MODEL);
    expect(
      resolveSubagentModelForImageToolResults(SUBAGENT_FREE_TEXT_MODEL, false),
    ).toBe(SUBAGENT_FREE_TEXT_MODEL);
  });

  it("prioritizes browser QA and longer complex children", () => {
    expect(
      resolveSubagentTriggerPriority({
        capabilities: ["browser_qa"],
        complexity: "medium",
        expectedDurationMinutes: 5,
        outputKind: "qa_report",
        subscription: "free",
      }),
    ).toBe(10);
    expect(
      resolveSubagentTriggerPriority({
        capabilities: ["code_read"],
        complexity: "high",
        expectedDurationMinutes: 10,
        outputKind: "answer",
        subscription: "free",
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
        subscription: "free",
      }),
    ).toBe(SUBAGENT_FREE_TEXT_MODEL);
  });

  it("promotes to DeepSeek V4 Flash Vision when an image tool result appears", () => {
    expect(
      resolveSubagentModelForImageToolResults(SUBAGENT_FREE_TEXT_MODEL, true),
    ).toBe(SUBAGENT_VISION_MODEL);
  });

  it("keeps the vision route sticky for later text-only steps", () => {
    expect(
      resolveSubagentModelForImageToolResults(SUBAGENT_VISION_MODEL, false),
    ).toBe(SUBAGENT_VISION_MODEL);
  });
});
