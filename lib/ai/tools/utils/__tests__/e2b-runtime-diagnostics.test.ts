import { Sandbox, type SandboxInfo } from "@e2b/code-interpreter";
import { readE2BRuntimeDiagnostics } from "../e2b-runtime-diagnostics";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { getMetrics: jest.fn() },
}));
const info = {
  sandboxId: "synthetic",
  state: "paused",
  envdVersion: "0.6.12",
  cpuCount: 4,
  memoryMB: 4096,
  metadata: { privateValue: "must-not-escape" },
} as unknown as SandboxInfo;
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(Sandbox.getMetrics).mockResolvedValue([]);
});

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
    templateBuildEnvdVersion: "0.6.12",
    runtimeEnvdVersion: null,
    runtimeMeetsReadinessMinimum: null,
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
  ).resolves.toMatchObject({
    templateBuildEnvdVersion: null,
    runtimeEnvdVersion: null,
    runtimeMeetsReadinessMinimum: null,
    metrics: null,
  });
});

it.each([
  ["0.10.0\n", true],
  ["v0.10.2\n", true],
  ["1.0.0\n", true],
  ["0.9.99\n", false],
])(
  "keeps runtime %s distinct from build-time metadata and provider rollout",
  async (stdout, expected) => {
    const run = jest.fn().mockResolvedValue({ exitCode: 0, stdout });
    const value = await readE2BRuntimeDiagnostics(
      { ...info, state: "running" },
      {},
      {
        sandboxId: info.sandboxId,
        commands: { run },
      } as never,
    );
    expect(value).toMatchObject({
      templateBuildEnvdVersion: "0.6.12",
      runtimeEnvdVersion: (stdout as string).trim(),
      runtimeVersionCheck: "observed",
      runtimeMeetsReadinessMinimum: expected,
      readinessSafeguardRollout: "unknown",
    });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/envd -version",
      expect.objectContaining({ timeoutMs: 2_000, requestTimeoutMs: 2_000 }),
    );
  },
);

it("does not wake a paused sandbox to check the actual version", async () => {
  const run = jest.fn();
  await expect(
    readE2BRuntimeDiagnostics(info, {}, {
      sandboxId: info.sandboxId,
      commands: { run },
    } as never),
  ).resolves.toMatchObject({
    runtimeVersionCheck: "not_checked_paused",
    runtimeEnvdVersion: null,
    runtimeMeetsReadinessMinimum: null,
  });
  expect(run).not.toHaveBeenCalled();
});

it.each(["failure", "invalid"])(
  "leaves runtime capability unknown on %s, without falling back to new build-time metadata",
  async (failure) => {
    const run =
      failure === "failure"
        ? jest.fn().mockRejectedValue(new Error("private error"))
        : jest.fn().mockResolvedValue({
            exitCode: 0,
            stdout: "private unrelated output",
          });
    const value = await readE2BRuntimeDiagnostics(
      { ...info, state: "running", envdVersion: "0.10.2" },
      {},
      {
        sandboxId: info.sandboxId,
        commands: { run },
      } as never,
    );
    expect(value).toMatchObject({
      templateBuildEnvdVersion: "0.10.2",
      runtimeEnvdVersion: null,
      runtimeVersionCheck: "unavailable",
      runtimeMeetsReadinessMinimum: null,
    });
    expect(JSON.stringify(value)).not.toContain("private");
  },
);
