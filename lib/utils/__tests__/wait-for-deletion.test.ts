import { waitForDeletion } from "../wait-for-deletion";

describe("waitForDeletion", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("waits through pending batches until explicit completion", async () => {
    const check = jest
      .fn()
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("pending")
      .mockResolvedValue("complete");
    const finished = jest.fn();
    const promise = waitForDeletion(check).then(finished);
    await jest.advanceTimersByTimeAsync(1000);
    expect(finished).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    await promise;
    expect(finished).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("does not turn a failed cleanup into success", async () => {
    await expect(waitForDeletion(async () => "failed")).rejects.toThrow(
      "could not be completed",
    );
  });

  it("fails explicitly if completion cannot be confirmed", async () => {
    const result = expect(
      waitForDeletion(async () => "pending", 2000),
    ).rejects.toThrow("could not confirm completion");
    await jest.advanceTimersByTimeAsync(2000);
    await result;
  });

  it("also bounds a status request that never returns", async () => {
    const result = expect(
      waitForDeletion(() => new Promise(() => {}), 2000),
    ).rejects.toThrow("could not confirm completion");
    await jest.advanceTimersByTimeAsync(2000);
    await result;
  });

  it("rejects malformed status instead of accepting it", async () => {
    await expect(
      waitForDeletion(async () => undefined as never),
    ).rejects.toThrow("Unable to confirm");
  });
});
