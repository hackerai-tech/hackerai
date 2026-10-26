import { Sandbox, type SandboxInfo } from "@e2b/code-interpreter";
import { readE2BRuntimeDiagnostics } from "../e2b-runtime-diagnostics";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { getMetrics: jest.fn() },
}));
const info = {
  sandboxId: "synthetic",
  envdVersion: "0.0.1",
  cpuCount: 4,
  memoryMB: 4096,
  metadata: { privateValue: "must-not-escape" },
} as unknown as SandboxInfo;

it("reports the freshest bounded numeric sample without metadata or credentials", async () => {
  const sample = {
    timestamp: new Date(Date.now() - 1_000),
    cpuUsedPct: 99,
    cpuCount: 4,
    memUsed: 100,
    memTotal: 110,
    memCache: 5,
    diskUsed: 200,
    diskTotal: 300,
  };
  jest.mocked(Sandbox.getMetrics).mockResolvedValue([
    sample,
    {
      ...sample,
      timestamp: new Date(Date.now() - 10 * 60_000),
      cpuUsedPct: 1,
    },
  ]);
  const result = await readE2BRuntimeDiagnostics(info, {
    apiKey: "private-key",
  });
  expect(result).toMatchObject({
    envdVersion: "0.0.1",
    metrics: { cpuUsedPct: 99 },
  });
  expect(JSON.stringify(result)).not.toMatch(/private|synthetic/);
  expect(Sandbox.getMetrics).toHaveBeenCalledWith(
    "synthetic",
    expect.objectContaining({ retries: 0, requestTimeoutMs: 2_000 }),
  );
});

it("keeps unknown metrics and invalid versions explicit when the provider is unavailable", async () => {
  jest.mocked(Sandbox.getMetrics).mockRejectedValue(new Error("timeout"));
  await expect(
    readE2BRuntimeDiagnostics(
      { ...info, envdVersion: "private error text" },
      {},
    ),
  ).resolves.toMatchObject({ envdVersion: null, metrics: null });
});
