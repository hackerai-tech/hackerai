import {
  getSummarizationModelAssignment,
  startSummarizationModelMeasurement,
} from "../model-experiment";
import {
  getPostHogFeatureFlagVariantForUser,
  phLogger,
} from "@/lib/posthog/server";
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagVariantForUser: jest.fn(),
  phLogger: { event: jest.fn() },
}));
const flag = jest.mocked(getPostHogFeatureFlagVariantForUser);
beforeEach(() => jest.clearAllMocks());

it.each([undefined, "unexpected", "true"])(
  "does not enroll an unrecognized assignment %s",
  async (value) => {
    flag.mockResolvedValue(value);
    const assignment = await getSummarizationModelAssignment("user");
    expect(assignment).toBeUndefined();
    expect(
      startSummarizationModelMeasurement({
        userId: "user",
        assignment,
        mode: "ask",
        scope: "durable",
        startupPolicy: "control",
      }),
    ).toBeUndefined();
    expect(phLogger.event).not.toHaveBeenCalled();
  },
);
it("selects GLM for an enrolled control user without emitting exposure during lookup", async () => {
  flag.mockResolvedValue("control");
  expect(await getSummarizationModelAssignment("user")).toEqual({
    variant: "control",
    modelKey: "model-glm-5.3-flash",
  });
  expect(flag).toHaveBeenCalledWith("summarization-deepseek-v41-v1", "user", {
    sendFeatureFlagEvents: false,
  });
  expect(phLogger.event).not.toHaveBeenCalled();
});
it("skips assignment without an authenticated user", async () => {
  expect(await getSummarizationModelAssignment()).toBeUndefined();
  expect(flag).not.toHaveBeenCalled();
});

it("fails open to normal GLM routing when flag evaluation rejects", async () => {
  flag.mockRejectedValue(new Error("analytics unavailable"));
  expect(await getSummarizationModelAssignment("user")).toBeUndefined();
});
