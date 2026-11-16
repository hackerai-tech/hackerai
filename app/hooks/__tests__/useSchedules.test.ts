import { schedulesRequest } from "../useSchedules";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each([null, "gateway timeout"])(
  "shows a useful fallback for an unusable response: %s",
  async (body) => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        if (typeof body === "string") throw new SyntaxError("Unexpected token");
        return body;
      },
    });
    await expect(schedulesRequest("/api/schedules")).rejects.toThrow(
      "Could not update schedules. Try again.",
    );
  },
);
it("preserves the server's actionable error message", async () => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: false,
    json: async () => ({
      message: "Wait a minute before running this schedule again.",
    }),
  });
  await expect(schedulesRequest("/api/schedules")).rejects.toThrow(
    "Wait a minute before running this schedule again.",
  );
});
