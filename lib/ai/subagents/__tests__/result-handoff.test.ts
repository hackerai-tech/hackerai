import { verifySubagentResultAfterHandoff } from "../result-handoff";

const accepted = { accepted: true as const, result: { summary: "verified" } };

it("rejects a takeover completed entirely during evidence verification, including a blank note", async () => {
  let notes: Array<{ id: string; text: string }> = [];
  const result = await verifySubagentResultAfterHandoff({
    verify: async () => {
      notes = [{ id: "saved-blank-takeover", text: "" }];
      return accepted;
    },
    getNotes: async () => notes,
    waitForControl: async () => false,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    accepted: false,
    error: expect.stringContaining("fresh browser snapshot"),
  });
});

it("rejects a result if it had to wait for human control, even before notes appear", async () => {
  expect(
    await verifySubagentResultAfterHandoff({
      verify: async () => accepted,
      getNotes: async () => [],
      waitForControl: async () => true,
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ accepted: false });
});

it("accepts unchanged saved context regardless of note query ordering", async () => {
  let reads = 0;
  expect(
    await verifySubagentResultAfterHandoff({
      verify: async () => accepted,
      getNotes: async () =>
        (++reads === 1 ? ["one", "two"] : ["two", "one"]).map((id) => ({ id })),
      waitForControl: async () => false,
      signal: new AbortController().signal,
    }),
  ).toBe(accepted);
});

it("preserves failed evidence verification without waiting for finalization", async () => {
  const rejected = { accepted: false as const, error: "Evidence missing" };
  const waitForControl = jest.fn();
  expect(
    await verifySubagentResultAfterHandoff({
      verify: async () => rejected,
      getNotes: async () => [],
      waitForControl,
      signal: new AbortController().signal,
    }),
  ).toBe(rejected);
  expect(waitForControl).not.toHaveBeenCalled();
});

it("does not accept results when the final note read fails", async () => {
  let reads = 0;
  await expect(
    verifySubagentResultAfterHandoff({
      verify: async () => accepted,
      getNotes: async () => {
        if (++reads === 2) throw new Error("Read unavailable");
        return [];
      },
      waitForControl: async () => false,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Read unavailable");
});

it("propagates cancellation during the ownership wait", async () => {
  const controller = new AbortController();
  await expect(
    verifySubagentResultAfterHandoff({
      verify: async () => accepted,
      getNotes: async () => [],
      waitForControl: async () => {
        controller.abort();
        return false;
      },
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});
