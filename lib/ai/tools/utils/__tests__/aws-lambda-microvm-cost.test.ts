import { AWS_LAMBDA_MICROVM_COST_PER_MS } from "../aws-lambda-microvm-cost";

describe("AWS Lambda MicroVM cost", () => {
  it("uses the 4 GiB and 2 vCPU baseline rate", () => {
    expect(AWS_LAMBDA_MICROVM_COST_PER_MS * 60 * 60 * 1000).toBeCloseTo(
      0.25220016,
      8,
    );
  });
});
