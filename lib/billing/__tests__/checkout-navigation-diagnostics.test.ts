import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { createCheckoutNavigationDiagnostics } from "../checkout-navigation-diagnostics";

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));

const capture = jest.mocked(captureAuthenticatedEvent);
const context = { attemptId: "ca_test_123", plan: "pro-monthly-plan" };

beforeEach(() => {
  jest.useFakeTimers();
  capture.mockReset();
});

afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  jest.useRealTimers();
});

it("sends before navigation and records departure without reporting Stripe load", () => {
  const diagnostics = createCheckoutNavigationDiagnostics(context);
  diagnostics.navigationRequested();
  expect(capture).toHaveBeenCalledWith(
    "checkout_navigation_requested",
    expect.objectContaining({ checkout_attempt_id: "ca_test_123" }),
    { send_instantly: true, transport: "sendBeacon" },
  );
  window.dispatchEvent(
    new PageTransitionEvent("pagehide", { persisted: true }),
  );
  jest.advanceTimersByTime(20_000);
  expect(capture.mock.calls.map(([event]) => event)).toEqual([
    "checkout_navigation_requested",
    "checkout_page_departed",
  ]);
  expect(capture.mock.calls[1][1]).toEqual(
    expect.objectContaining({ persisted: true }),
  );
});

it("records an unconfirmed navigation once and removes the departure listener", () => {
  createCheckoutNavigationDiagnostics(context).navigationRequested();
  jest.advanceTimersByTime(10_000);
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  expect(capture.mock.calls.map(([event]) => event)).toEqual([
    "checkout_navigation_requested",
    "checkout_navigation_unconfirmed",
  ]);
  expect(capture.mock.calls[1][1]).toEqual(
    expect.objectContaining({
      elapsed_ms: 10_000,
      observation_window_ms: 10_000,
      visibility_state: document.visibilityState,
    }),
  );
});

it("cancels observation on navigation failure and sends only bounded context", () => {
  const diagnostics = createCheckoutNavigationDiagnostics({
    ...context,
    source: "https://private.example/?token=secret",
  });
  diagnostics.navigationRequested();
  diagnostics.failed("navigation_exception");
  jest.advanceTimersByTime(20_000);
  expect(capture.mock.calls.map(([event]) => event)).toEqual([
    "checkout_navigation_requested",
    "checkout_client_error",
  ]);
  expect(JSON.stringify(capture.mock.calls)).not.toContain("secret");
});

it("does not throw or change checkout when analytics is unavailable", () => {
  capture.mockImplementation(() => {
    throw new Error("analytics unavailable");
  });
  const diagnostics = createCheckoutNavigationDiagnostics(context);
  expect(() => {
    diagnostics.responseReceived(200);
    diagnostics.navigationRequested();
    diagnostics.failed("navigation_exception");
  }).not.toThrow();
});
