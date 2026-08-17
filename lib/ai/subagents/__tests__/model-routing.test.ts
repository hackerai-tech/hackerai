import { describe, expect, it } from "@jest/globals";

import {
  resolveSubagentModelForImageToolResults,
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
