import { describe, expect, it } from "@jest/globals";

import { createSubagentUpdateMessageId } from "../fingerprint";

describe("subagent coordination fingerprints", () => {
  it("deduplicates retries of one update without collapsing separate tool calls", () => {
    const first = createSubagentUpdateMessageId(
      "parent-run",
      "sa_validator",
      "tool-call-1",
    );

    expect(
      createSubagentUpdateMessageId(
        "parent-run",
        "sa_validator",
        "tool-call-1",
      ),
    ).toBe(first);
    expect(
      createSubagentUpdateMessageId(
        "parent-run",
        "sa_validator",
        "tool-call-2",
      ),
    ).not.toBe(first);
  });
});
