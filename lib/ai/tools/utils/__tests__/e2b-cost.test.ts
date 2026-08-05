import { E2B_COST_PER_MS } from "../e2b-cost";

describe("E2B sandbox cost", () => {
  it("uses the 4 vCPU and 4 GiB hourly rate", () => {
    expect(E2B_COST_PER_MS * 60 * 60 * 1000).toBeCloseTo(0.2664, 10);
  });
});
