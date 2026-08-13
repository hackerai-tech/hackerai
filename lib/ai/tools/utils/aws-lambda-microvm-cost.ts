// AWS Lambda MicroVM Graviton rates for the first pricing tier, measured per
// second. Keep these isolated so pricing can be updated without changing the
// provider lifecycle implementation.
const VCPU_SECOND_USD = 0.0000276944;
const MEMORY_GIB_SECOND_USD = 0.0000036667;
const DEFAULT_BASELINE_VCPU = 2;
const DEFAULT_BASELINE_MEMORY_GIB = 4;

export const AWS_LAMBDA_MICROVM_COST_PER_MS =
  (DEFAULT_BASELINE_VCPU * VCPU_SECOND_USD +
    DEFAULT_BASELINE_MEMORY_GIB * MEMORY_GIB_SECOND_USD) /
  1000;
