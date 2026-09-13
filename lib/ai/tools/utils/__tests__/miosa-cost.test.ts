import {
  MIOSA_COST_PER_MS,
  MIOSA_CPU_COUNT,
  MIOSA_MEMORY_MB,
  MIOSA_DISK_SIZE_MB,
} from "../miosa-cost";

it("converts the verified quad hourly price to dollars without cent rounding", () => {
  expect([MIOSA_CPU_COUNT, MIOSA_MEMORY_MB, MIOSA_DISK_SIZE_MB]).toEqual([
    4, 4096, 20480,
  ]);
  expect(MIOSA_COST_PER_MS * 3_600_000).toBeCloseTo(0.252054, 12);
  expect(MIOSA_COST_PER_MS * 60_000).toBeCloseTo(0.0042009, 12);
  expect(MIOSA_COST_PER_MS * 250).toBeCloseTo(0.00001750375, 12);
});
