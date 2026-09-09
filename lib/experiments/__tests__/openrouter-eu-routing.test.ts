import {
  resolveOpenRouterRegionOptions,
  OPENROUTER_EU_ROUTING_FLAG,
} from "../openrouter-eu-routing";
import type { PostHog } from "posthog-node";

describe("Europe routing assignment and exposure", () => {
  const evaluateFlags = jest.fn();
  const capture = jest.fn();
  const posthog = { evaluateFlags, capture } as unknown as Pick<
    PostHog,
    "evaluateFlags" | "capture"
  >;
  const args = { posthog, userId: "test-user", isEuropeanUser: true };
  beforeEach(() => {
    jest.useFakeTimers();
    evaluateFlags.mockReset().mockResolvedValue({ getFlag: () => true });
    capture.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it("never enables EU routing for users outside Europe", async () => {
    expect(
      await resolveOpenRouterRegionOptions({ ...args, isEuropeanUser: false }),
    ).toEqual({});
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it.each([false, undefined, "true"])(
    "uses global for a missing or disabled flag (%s)",
    async (value) => {
      evaluateFlags.mockResolvedValue({ getFlag: () => value });
      expect(await resolveOpenRouterRegionOptions(args)).toEqual({});
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it("records exposure only when EU inference is attempted, once per request", async () => {
    const options = await resolveOpenRouterRegionOptions(args);
    expect(options.preferEurope).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    options.onRoute?.("eu");
    options.onRoute?.("eu");
    options.onRoute?.("global_no_eu_endpoint");
    expect(capture.mock.calls).toEqual([
      [
        {
          distinctId: "test-user",
          event: "openrouter_eu_routing_exposed",
          properties: {
            [`$feature/${OPENROUTER_EU_ROUTING_FLAG}`]: true,
            route_outcome: "eu",
            $process_person_profile: false,
          },
        },
      ],
      [
        {
          distinctId: "test-user",
          event: "openrouter_eu_routing_global_fallback",
          properties: {
            [`$feature/${OPENROUTER_EU_ROUTING_FLAG}`]: true,
            route_outcome: "global_no_eu_endpoint",
            $process_person_profile: false,
          },
        },
      ],
    ]);
  });

  it("uses global on missing analytics or flag errors", async () => {
    expect(
      await resolveOpenRouterRegionOptions({ ...args, posthog: null }),
    ).toEqual({});
    evaluateFlags.mockRejectedValue(new Error("Flag service unavailable"));
    expect(await resolveOpenRouterRegionOptions(args)).toEqual({});
  });

  it("bounds the flag lookup to one second", async () => {
    evaluateFlags.mockReturnValue(new Promise(() => {}));
    const result = resolveOpenRouterRegionOptions(args);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({});
  });
});
