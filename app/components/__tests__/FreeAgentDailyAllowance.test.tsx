import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FreeAgentDailyAllowance } from "../FreeAgentDailyAllowance";
let mockUser = { id: "user-1" };
let mockSubscription = "free";
let mockMode = "agent";
const mockFetch = jest.fn();
const mockCapture = jest.fn();
const mockImpression = jest.fn();
let mockAnalyticsUser: string | null = "user-1";
const mockAnalyticsListeners = new Set<() => void>();
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
  captureUpgradeCtaImpression: (...args: unknown[]) => mockImpression(...args),
  getIdentifiedAnalyticsUserId: () => mockAnalyticsUser,
  subscribeAuthenticatedAnalytics: (listener: () => void) => {
    mockAnalyticsListeners.add(listener);
    return () => mockAnalyticsListeners.delete(listener);
  },
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
  mockAnalyticsUser = "user-1";
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
    expect.objectContaining({ source: "free_agent_daily_allowance_exhausted" }),
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

it("records visible exhaustion only after a response and attributes its Upgrade separately", async () => {
  render(view());
  await screen.findByText(/one completed response per day/);
  expect(mockImpression).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Upgrade"));
  expect(mockPricing).toHaveBeenLastCalledWith(
    expect.objectContaining({
      source: "free_agent_daily_allowance",
      reason: "free_agent_daily_allowance",
    }),
  );
  mockFetch.mockResolvedValue(response(true));
  fireEvent(window, new Event("focus"));
  await screen.findByText(/used today's/);
  expect(mockImpression).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "free_agent_daily_allowance_exhausted",
      surface: "composer",
      from_tier: "free",
      reason: "free_agent_daily_completed",
      "$feature/free-agent-completed-daily-v1": "test",
    }),
  );
  fireEvent.click(screen.getByText("Upgrade"));
  expect(mockPricing).toHaveBeenLastCalledWith(
    expect.objectContaining({
      source: "free_agent_daily_allowance_exhausted",
      reason: "free_agent_daily_completed",
    }),
  );
});

it("waits for the displayed account's analytics identity before recording exhaustion", async () => {
  mockAnalyticsUser = "previous-account";
  mockFetch.mockResolvedValue(response(true));
  render(view());
  await screen.findByText(/used today's/);
  expect(mockImpression).not.toHaveBeenCalled();
  act(() => {
    mockAnalyticsUser = "user-1";
    mockAnalyticsListeners.forEach((listener) => listener());
  });
  await waitFor(() => expect(mockImpression).toHaveBeenCalled());
});

it("does not record exhaustion for control, paid, or running states", async () => {
  mockFetch.mockResolvedValue(response(true, "control"));
  const { rerender } = render(view());
  await waitFor(() => expect(mockCapture).toHaveBeenCalled());
  expect(mockImpression).not.toHaveBeenCalled();
  mockSubscription = "pro";
  rerender(view());
  expect(mockImpression).not.toHaveBeenCalled();
  mockSubscription = "free";
  rerender(view(true));
  expect(mockImpression).not.toHaveBeenCalled();
});
