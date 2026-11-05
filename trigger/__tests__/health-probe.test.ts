jest.mock("@trigger.dev/sdk", () => ({
  task: (definition: unknown) => definition,
}));

import { healthProbeTask } from "../health-probe";

const run = (
  healthProbeTask as unknown as {
    run: (payload: {
      nonce: string;
      includeRuntimeIdentity?: boolean;
    }) => Promise<{
      nonce: string;
      runtimeIdentity?: { nodeVersion: string };
    }>;
  }
).run;

describe("Agent runtime health probe", () => {
  it("keeps routine probes limited to their nonce", async () => {
    await expect(run({ nonce: "routine-probe" })).resolves.toEqual({
      nonce: "routine-probe",
    });
  });

  it("reports the executing Node binary only when runtime identity is requested", async () => {
    await expect(
      run({ nonce: "runtime-probe", includeRuntimeIdentity: true }),
    ).resolves.toMatchObject({
      nonce: "runtime-probe",
      runtimeIdentity: { nodeVersion: process.versions.node },
    });
  });
});
