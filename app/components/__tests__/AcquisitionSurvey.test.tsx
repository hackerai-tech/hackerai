import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  USE_CASE_SURVEY_STORAGE_KEY,
  USE_CASE_QUESTION,
  USE_CASE_OPTIONS,
} from "@/lib/analytics/acquisition-survey";
import { surveyDefinition } from "@/lib/analytics/test-support/acquisition-survey-fixture";
const mockCapture = jest.fn();
const mockFetch = jest.fn();
let mockUser = { id: "", createdAt: new Date().toISOString() };
let mockOrganizationId: string | undefined;
let mockSubscription = "free";
let mockAnalyticsUserId: string | null;
const mockListeners = new Set<() => void>();
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: mockUser, organizationId: mockOrganizationId }),
}));
jest.mock("../../contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: mockSubscription }),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
  getIdentifiedAnalyticsUserId: () => mockAnalyticsUserId,
  subscribeAuthenticatedAnalytics: (listener: () => void) => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
}));
import { AcquisitionSurvey } from "../AcquisitionSurvey";
let observers: Array<
  (
    entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>,
  ) => void
>;
const inView = (ratio = 1) =>
  act(() =>
    observers.forEach((callback) =>
      callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    ),
  );
let userSequence = 0;
const response = () => ({
  ok: true,
  json: async () => ({
    available: true,
    survey: {
      id: surveyDefinition.id,
      questionId: surveyDefinition.questions[0].id,
    },
  }),
});
const prompt = () =>
  screen.findByRole("complementary", { name: "Optional use case survey" });
describe("optional inline marketing survey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockUser = {
      id: `survey-user-${++userSequence}`,
      createdAt: new Date().toISOString(),
    };
    mockOrganizationId = undefined;
    mockSubscription = "free";
    mockAnalyticsUserId = mockUser.id;
    mockFetch.mockResolvedValue(response());
    global.fetch = mockFetch;
    mockCapture.mockReturnValue(true);
    observers = [];
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    global.IntersectionObserver = jest.fn((callback) => {
      observers.push(callback);
      return { observe: jest.fn(), disconnect: jest.fn() };
    }) as unknown as typeof IntersectionObserver;
  });
  it("renders one question inline without moving focus and measures actual visibility", async () => {
    render(
      <>
        <input aria-label="Chat input" />
        <AcquisitionSurvey activationMode="ask" />
      </>,
    );
    screen.getByLabelText("Chat input").focus();
    await prompt();
    expect(
      screen.queryByRole("textbox", { name: USE_CASE_QUESTION }),
    ).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(6);
    expect(document.activeElement).toBe(screen.getByLabelText("Chat input"));
    expect(mockCapture).not.toHaveBeenCalled();
    inView(0.49);
    expect(mockCapture).not.toHaveBeenCalled();
    inView(0.5);
    inView();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "survey shown" }),
    );
  });
  it("records one native PostHog response with only a structured use case", async () => {
    render(<AcquisitionSurvey activationMode="agent" />);
    await prompt();
    const renderedOrder = within(
      screen.getByRole("group", { name: USE_CASE_QUESTION }),
    )
      .getAllByRole("button")
      .map(
        (button) =>
          USE_CASE_OPTIONS.find(({ label }) => label === button.textContent)
            ?.value,
      );
    fireEvent.click(
      screen.getByRole("button", { name: "Learning security / CTFs" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Thanks for sharing.");
    const sent = mockCapture.mock.calls.find(
      ([event]) => event.event === "survey sent",
    )?.[0];
    expect(sent).toEqual(
      expect.objectContaining({
        dedupeKey: surveyDefinition.id,
        properties: expect.objectContaining({
          $survey_id: surveyDefinition.id,
          [`$survey_response_${surveyDefinition.questions[0].id}`]:
            "Learning security / CTFs",
          $survey_completed: true,
          use_case: "learning",
          activation_mode: "agent",
          option_order: renderedOrder,
          option_order_version: 1,
          $set_once: expect.objectContaining({
            marketing_use_case_survey_completed_v2: true,
            marketing_use_case_v2: "learning",
          }),
        }),
      }),
    );
    expect(
      mockCapture.mock.calls.filter(([event]) => event.event === "survey sent"),
    ).toHaveLength(1);
    expect(
      window.localStorage.getItem(
        `${USE_CASE_SURVEY_STORAGE_KEY}:${mockUser.id}`,
      ),
    ).toBe("answered");
  });
  it("dismisses without treating dismissal as an answer", async () => {
    render(<AcquisitionSurvey activationMode="ask" />);
    await prompt();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss survey" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(mockCapture.mock.calls.map(([event]) => event.event)).toEqual([
      "survey shown",
      "survey dismissed",
    ]);
    expect(mockCapture.mock.calls[1][0].properties).not.toHaveProperty(
      "use_case",
    );
  });
  it("waits for consent and the matching identified account, then hides on withdrawal", async () => {
    mockAnalyticsUserId = null;
    render(<AcquisitionSurvey activationMode="ask" />);
    expect(mockFetch).not.toHaveBeenCalled();
    act(() => {
      mockAnalyticsUserId = mockUser.id;
      mockListeners.forEach((listener) => listener());
    });
    await prompt();
    act(() => {
      mockAnalyticsUserId = null;
      mockListeners.forEach((listener) => listener());
    });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(mockCapture).not.toHaveBeenCalled();
  });
  it.each(["paid", "team", "old", "unidentified"])(
    "does not fetch or show for %s users",
    (kind) => {
      if (kind === "paid") mockSubscription = "pro";
      if (kind === "team") mockOrganizationId = "org";
      if (kind === "old") mockUser.createdAt = "2020-01-01T00:00:00Z";
      if (kind === "unidentified") mockAnalyticsUserId = "another-account";
      render(<AcquisitionSurvey activationMode="ask" />);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );
  it("never counts a hidden tab as exposure", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    render(<AcquisitionSurvey activationMode="ask" />);
    await prompt();
    inView();
    expect(mockCapture).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
  it("does not show a delayed response after unmount, but works in Strict Mode", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = render(<AcquisitionSurvey activationMode="ask" />);
    first.unmount();
    await act(async () => resolve(response()));
    expect(screen.queryByRole("complementary")).toBeNull();
    render(
      <StrictMode>
        <AcquisitionSurvey activationMode="ask" />
      </StrictMode>,
    );
    await prompt();
  });
  it("suppresses another invitation after exposure and closes when another tab finishes", async () => {
    const first = render(<AcquisitionSurvey activationMode="ask" />);
    await prompt();
    fireEvent(
      window,
      new StorageEvent("storage", {
        key: `${USE_CASE_SURVEY_STORAGE_KEY}:${mockUser.id}`,
        newValue: "answered",
      }),
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    first.unmount();
    window.localStorage.setItem(
      `${USE_CASE_SURVEY_STORAGE_KEY}:${mockUser.id}`,
      "answered",
    );
    mockFetch.mockClear();
    render(<AcquisitionSurvey activationMode="ask" />);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it("keeps the answer retryable when capture fails, and tolerates blocked storage", async () => {
    const storageSpy = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      render(<AcquisitionSurvey activationMode="ask" />);
      await prompt();
      mockCapture.mockReturnValueOnce(false);
      fireEvent.click(screen.getByRole("button", { name: "Bug bounty" }));
      expect(screen.getByRole("status")).toHaveTextContent("Couldn’t record");
      fireEvent.click(screen.getByRole("button", { name: "Bug bounty" }));
      expect(screen.getByRole("status")).toHaveTextContent(
        "Thanks for sharing.",
      );
    } finally {
      storageSpy.mockRestore();
    }
  });
  it("fails closed for an unavailable or malformed server configuration", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ available: true, survey: { id: "wrong" } }),
    });
    render(<AcquisitionSurvey activationMode="ask" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
