// Tenant computePricing() verified 2026-09-11: quad, 4 vCPU / 4 GiB /
// 20 GiB, 25.2054 credits/hour, 1 cent/credit. This is the request runtime
// allocation rate, not a delta of the sandbox-lifetime usage estimate.
// Keep this rate and the provisioned shape together when either changes.
export const MIOSA_CPU_COUNT = 4;
export const MIOSA_MEMORY_MB = 4 * 1024;
export const MIOSA_DISK_SIZE_MB = 20 * 1024;
export const MIOSA_COST_PER_MS = 0.252054 / 3_600_000;
