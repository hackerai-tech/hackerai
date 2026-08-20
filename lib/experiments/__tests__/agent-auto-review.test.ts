import { DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT } from "@/lib/experiments/agent-auto-review";

describe("Agent Auto review default", () => {
  it("always uses enforcement", () => {
    expect(DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT).toEqual({ phase: "enforce" });
  });
});
