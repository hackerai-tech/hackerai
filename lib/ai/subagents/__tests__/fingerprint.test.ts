import { describe, expect, it } from "@jest/globals";

import {
  createAgentFingerprint,
  createSubagentUpdateMessageId,
} from "../fingerprint";

describe("subagent coordination fingerprints", () => {
  it("keeps profile and success criteria in generic task deduplication", () => {
    const generic = createAgentFingerprint({
      profile: "security_task",
      name: "Mapper",
      task: "Trace authorization",
      successCriteria: ["Find the enforcing function"],
      skills: [],
    });

    expect(generic).not.toBe(
      createAgentFingerprint({
        profile: "security_validation",
        name: "Mapper",
        task: "Trace authorization",
        successCriteria: ["Find the enforcing function"],
        skills: [],
      }),
    );
    expect(generic).not.toBe(
      createAgentFingerprint({
        profile: "security_task",
        name: "Mapper",
        task: "Trace authorization",
        successCriteria: ["Exercise the endpoint"],
        skills: [],
      }),
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
