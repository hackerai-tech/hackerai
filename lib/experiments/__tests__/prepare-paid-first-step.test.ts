import { preparePaidFirstStepEnrollment } from "../prepare-paid-first-step";
import { getPaidFirstStepEnrollment } from "../paid-first-step-enrollment";
import PostHogClient from "@/app/posthog";

jest.mock("@/app/posthog", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../paid-first-step-enrollment", () => ({
  getPaidFirstStepEnrollment: jest.fn(),
}));
const posthog = { getFeatureFlag: jest.fn(), shutdown: jest.fn() };
const args = {
  userId: "u",
  organizationId: "org",
  subscription: "pro" as const,
};
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(PostHogClient).mockReturnValue(posthog as never);
  posthog.getFeatureFlag.mockResolvedValue("control");
  posthog.shutdown.mockResolvedValue(undefined);
});
it("prepares the authenticated paid user's immutable assignment before worker dispatch", async () => {
  await preparePaidFirstStepEnrollment(args);
  expect(getPaidFirstStepEnrollment).toHaveBeenCalledWith({
    ...args,
    variant: "control",
  });
  expect(posthog.getFeatureFlag).toHaveBeenCalledWith(
    "abliterated_paid_first_step_v1",
    "u",
    expect.objectContaining({ sendFeatureFlagEvents: false }),
  );
  expect(posthog.shutdown).toHaveBeenCalled();
});
it.each([
  { isAutomaticContinuation: true },
  { limitRescue: true },
  { subscription: "free" as const },
  { subscription: "team" as const },
  { organizationId: undefined },
])("does not prepare ineligible requests", async (changes) => {
  await preparePaidFirstStepEnrollment({ ...args, ...changes });
  expect(PostHogClient).not.toHaveBeenCalled();
  expect(getPaidFirstStepEnrollment).not.toHaveBeenCalled();
});
it("does not enroll when the live flag is disabled", async () => {
  posthog.getFeatureFlag.mockResolvedValue(false);
  await preparePaidFirstStepEnrollment(args);
  expect(getPaidFirstStepEnrollment).not.toHaveBeenCalled();
  expect(posthog.shutdown).toHaveBeenCalled();
});
it("does not prevent Agent dispatch after a billing failure", async () => {
  jest
    .mocked(getPaidFirstStepEnrollment)
    .mockRejectedValue(Error("unavailable"));
  await expect(preparePaidFirstStepEnrollment(args)).resolves.toBeUndefined();
  expect(posthog.shutdown).toHaveBeenCalled();
});
