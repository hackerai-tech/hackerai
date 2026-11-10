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

  it("attributes the shipped Free policy without claiming a flag assignment", () => {
    expect(
      getExperimentAnalyticsProperties({
        key: "abliterated_free_three_steps_default_v1",
        variant: "test",
        requestId: "run-default",
      }),
    ).toEqual({
      experiment_key: "abliterated_free_three_steps_default_v1",
      experiment_variant: "test",
      experiment_request_id: "run-default",
      routing_policy: "abliterated_free_three_steps_default_v1",
    });
  });
});
