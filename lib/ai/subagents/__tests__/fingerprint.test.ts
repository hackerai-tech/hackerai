import { describe, expect, it } from "@jest/globals";

import {
  createAgentFingerprint,
  createSubagentUpdateMessageId,
} from "../fingerprint";

describe("subagent coordination fingerprints", () => {
  it("keeps profile and success criteria in generic task deduplication", () => {
    const generic = createAgentFingerprint(
      "security_task",
      "Mapper",
      "Trace authorization",
      ["Find the enforcing function"],
      [],
    );

    expect(generic).not.toBe(
      createAgentFingerprint(
        "security_validation",
        "Mapper",
        "Trace authorization",
        ["Find the enforcing function"],
        [],
      ),
    );
    expect(generic).not.toBe(
      createAgentFingerprint(
        "security_task",
        "Mapper",
        "Trace authorization",
        ["Exercise the endpoint"],
        [],
      ),
    );
  });

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
