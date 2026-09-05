import { assertSubagentRunRegion } from "../region-guard";

describe("subagent region validation cleanup", () => {
  const mismatch = {
    requestedRegion: "eu-central-1" as const,
    actualRegion: "us-east-1",
    environmentType: "PREVIEW" as const,
  };

  it("fails the reservation before rejecting a region mismatch", async () => {
    let release!: () => void;
    const finalize = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const pending = assertSubagentRunRegion(mismatch, finalize);
    void pending.catch(() => {
      settled = true;
    });
    expect(finalize).toHaveBeenCalledWith({
      status: "failed",
      summary: "Subagent failed region validation before starting.",
      failureCode: "region_mismatch",
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toMatchObject({
      code: "TRIGGER_REGION_MISMATCH",
    });
  });

  it("preserves the region error when reservation finalization fails", async () => {
    await expect(
      assertSubagentRunRegion(mismatch, async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toMatchObject({ code: "TRIGGER_REGION_MISMATCH" });
  });

  it("does not finalize a correctly placed run", async () => {
    const finalize = jest.fn();
    await assertSubagentRunRegion(
      { ...mismatch, actualRegion: "eu-central-1" },
      finalize,
    );
    expect(finalize).not.toHaveBeenCalled();
  });
});
