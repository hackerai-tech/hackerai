import { describe, expect, it } from "@jest/globals";

import {
  extractSubagentDeliveryClaims,
  requiresSubagentParentGate,
} from "../parent-delivery";

describe("subagent parent delivery", () => {
  it("extracts and deduplicates delivery acknowledgements from wait results", () => {
    const toolResults = [
      {
        toolName: "wait_for_agents",
        output: {
          success: true,
          _delivery_claim: { subagent_id: "sa_1", claim_id: "claim_1" },
        },
      },
      {
        toolName: "wait_for_agents",
        output: {
          _delivery_claim: { subagent_id: "sa_1", claim_id: "claim_1" },
        },
      },
      { toolName: "other", output: { success: true } },
    ];

    expect(extractSubagentDeliveryClaims(toolResults)).toEqual([
      { subagent_id: "sa_1", claim_id: "claim_1" },
    ]);
  });

  it("blocks completion for active or unconsumed children", () => {
    expect(
      requiresSubagentParentGate({
        activeCount: 1,
        unconsumedSubagentIds: [],
      }),
    ).toBe(true);
    expect(
      requiresSubagentParentGate({
        activeCount: 0,
        unconsumedSubagentIds: ["sa_1"],
      }),
    ).toBe(true);
  });

  it("allows exactly the result being injected to reach a synthesis step", () => {
    expect(
      requiresSubagentParentGate(
        { activeCount: 0, unconsumedSubagentIds: ["sa_1"] },
        [{ subagent_id: "sa_1", claim_id: "claim_1" }],
      ),
    ).toBe(false);
    expect(
      requiresSubagentParentGate(
        {
          activeCount: 0,
          unconsumedSubagentIds: ["sa_1", "sa_2"],
        },
        [{ subagent_id: "sa_1", claim_id: "claim_1" }],
      ),
    ).toBe(true);
  });
});
