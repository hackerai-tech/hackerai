import { getExperimentAnalyticsProperties } from "../experiment-context";

describe("experiment analytics context", () => {
  it("adds the generic and PostHog feature properties", () => {
    expect(
      getExperimentAnalyticsProperties({
        key: "example_experiment",
        variant: "treatment",
      }),
    ).toEqual({
      experiment_key: "example_experiment",
      experiment_variant: "treatment",
      "$feature/example_experiment": "treatment",
    });
  });

  it("adds nothing without an experiment", () => {
    expect(getExperimentAnalyticsProperties(undefined)).toEqual({});
  });
});
