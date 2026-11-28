import { AgentApprovalAuthorizationError } from "@/lib/chat/agent-approval-authorization";
import { assertResumedAgentRunCapacity } from "@/lib/chat/agent-resume-capacity";
import {
  verifyPaidDailyFreeAllowanceReservationOwnership,
  type PaidDailyFreeAllowanceReservation,
} from "@/lib/rate-limit/paid-daily-free-allowance";

jest.mock("@/lib/rate-limit/paid-daily-free-allowance", () => ({
  verifyPaidDailyFreeAllowanceReservationOwnership: jest.fn(),
}));

const verifyOwnership = jest.mocked(
  verifyPaidDailyFreeAllowanceReservationOwnership,
);
const reservation = {
  allowed: true,
} as unknown as PaidDailyFreeAllowanceReservation;
const exhaustedCapacity = () =>
  Promise.reject(new Error("monthly usage limit reached"));

beforeEach(() => jest.clearAllMocks());

it("lets an allowance run resume on its lease although included capacity is exhausted", async () => {
  verifyOwnership.mockResolvedValue({ owned: true });
  const checkCapacity = jest.fn(exhaustedCapacity);

  await expect(
    assertResumedAgentRunCapacity({
      userId: "user-1",
      admittedAllowanceReservation: reservation,
      checkCapacity,
    }),
  ).resolves.toBeUndefined();

  expect(verifyOwnership).toHaveBeenCalledWith("user-1", reservation);
  expect(checkCapacity).not.toHaveBeenCalled();
});

it("stops an allowance run that lost its lease without falling back to other billing", async () => {
  verifyOwnership.mockResolvedValue({
    owned: false,
    reason: "reservation_unavailable",
  });
  const checkCapacity = jest.fn(() => Promise.resolve());
  const onAllowanceLost = jest.fn();

  await expect(
    assertResumedAgentRunCapacity({
      userId: "user-1",
      admittedAllowanceReservation: reservation,
      checkCapacity,
      onAllowanceLost,
    }),
  ).rejects.toBeInstanceOf(AgentApprovalAuthorizationError);

  expect(onAllowanceLost).toHaveBeenCalledWith("reservation_unavailable");
  expect(checkCapacity).not.toHaveBeenCalled();
});

it("applies the normal capacity check to runs admitted on included capacity", async () => {
  await expect(
    assertResumedAgentRunCapacity({
      userId: "user-1",
      admittedAllowanceReservation: undefined,
      checkCapacity: exhaustedCapacity,
    }),
  ).rejects.toThrow("monthly usage limit reached");

  expect(verifyOwnership).not.toHaveBeenCalled();
});
