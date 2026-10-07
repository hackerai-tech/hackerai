import { PostHog } from "posthog-node";
import { getPostHogFlagWithoutExposure } from "../flag-assignment";

// Use the pinned SDK with a fake /flags response to verify event behavior,
// rather than assuming the assignment and snapshot APIs have the same contract.
describe("PostHog assignment without exposure", () => {
  it("preserves values without automatic exposure or deprecation warnings", async () => {
    const fetch = jest.fn(
      async (_url: string, _options?: { body?: string }) => ({
        status: 200,
        text: async () => "",
        json: async () => ({
          flags: {
            treatment: { key: "treatment", enabled: true, variant: "test" },
            enabled: { key: "enabled", enabled: true },
            disabled: { key: "disabled", enabled: false, variant: "test" },
          },
        }),
      }),
    );
    const client = new PostHog("test-project-key", {
      host: "https://posthog.test",
      fetch,
      flushInterval: 0,
    });
    const capture = jest.spyOn(client, "capture").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [key, value] of [
        ["treatment", "test"],
        ["enabled", true],
        ["disabled", false],
        ["missing", undefined],
      ] as const) {
        await expect(
          getPostHogFlagWithoutExposure(client, key, "user", {
            subscription_tier: "pro",
          }),
        ).resolves.toBe(value);
      }
      expect(capture).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(4);
      const options = fetch.mock.calls[0]?.[1] as { body: string };
      expect(JSON.parse(options.body)).toMatchObject({
        distinct_id: "user",
        person_properties: { subscription_tier: "pro" },
      });

      const flags = await client.evaluateFlags("user", {
        flagKeys: ["treatment"],
      });
      expect(flags.getFlag("treatment")).toBe("test");
      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({ event: "$feature_flag_called" }),
      );
    } finally {
      capture.mockRestore();
      warn.mockRestore();
      await client.shutdown();
    }
  });
});
