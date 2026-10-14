import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FreeAgentDailyAllowance } from "../FreeAgentDailyAllowance";
let mockUser = { id: "user-1" };
let mockSubscription = "free";
let mockMode = "agent";
const mockFetch = jest.fn();
const mockCapture = jest.fn();
const mockSetMode = jest.fn();
const mockPricing = jest.fn();
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: mockUser }),
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
    isCheckingProPlan: false,
    chatMode: mockMode,
    setChatMode: mockSetMode,
  }),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: (...args: unknown[]) => mockPricing(...args),
}));
const response = (completed: boolean, variant = "test") => ({
  ok: true,
  json: async () => ({
    status: {
      assignment: { variant },
      completed,
      resetTimestamp: Date.now() + 3600_000,
    },
  }),
});
const view = (running = false) => (
  <FreeAgentDailyAllowance running={running}>
    {(blocked) => <button disabled={blocked}>Send task</button>}
  </FreeAgentDailyAllowance>
);
beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: "user-1" };
  mockSubscription = "free";
  mockMode = "agent";
  mockCapture.mockReturnValue(true);
  global.fetch = mockFetch;
  mockFetch.mockResolvedValue(response(false));
});
it("discloses the allowance before usage without blocking the first response", async () => {
  render(view());
  await screen.findByText(/one completed response per day/);
  expect(screen.getByText("Send task")).toBeEnabled();
  expect(mockCapture).toHaveBeenCalledWith(
    "$feature_flag_called",
    expect.objectContaining({
      $feature_flag_response: "test",
      exposure_surface: "composer",
    }),
  );
});
it("blocks another send, retains composer, and offers Ask and the existing pricing flow", async () => {
  mockFetch.mockResolvedValue(response(true));
  render(view());
  await screen.findByText(/used today's free Agent allowance/);
  expect(screen.getByText("Send task")).toBeDisabled();
  fireEvent.click(screen.getByText("Use Ask"));
  expect(mockSetMode).toHaveBeenCalledWith("ask");
  fireEvent.click(screen.getByText("Upgrade"));
  expect(mockPricing).toHaveBeenCalledWith(
    expect.objectContaining({ source: "free_agent_daily_allowance" }),
  );
});
it("preserves control and records its actual composer exposure", async () => {
  mockFetch.mockResolvedValue(response(true, "control"));
  render(view());
  await waitFor(() => expect(mockCapture).toHaveBeenCalled());
  expect(screen.getByText("Send task")).toBeEnabled();
  expect(
    screen.queryByTestId("free-agent-daily-allowance"),
  ).not.toBeInTheDocument();
});
it("immediately bypasses the gate for paid accounts and in-flight requests", async () => {
  mockFetch.mockResolvedValue(response(true));
  const { rerender } = render(view());
  await screen.findByText(/used today's/);
  rerender(view(true));
  expect(screen.getByText("Send task")).toBeEnabled();
  mockSubscription = "pro";
  rerender(view());
  expect(screen.getByText("Send task")).toBeEnabled();
});
it("does not show another account's allowance and fails open on lookup error", async () => {
  mockFetch.mockResolvedValue(response(true));
  const { rerender } = render(view());
  await screen.findByText(/used today's/);
  mockUser = { id: "user-2" };
  mockFetch.mockRejectedValue(new Error("unavailable"));
  rerender(view());
  expect(screen.getByText("Send task")).toBeEnabled();
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
});
it("does not fetch or show an Agent gate in Ask", () => {
  mockMode = "ask";
  render(view());
  expect(mockFetch).not.toHaveBeenCalled();
  expect(screen.getByText("Send task")).toBeEnabled();
});
