import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  TaskOutcomeFeedback,
  TaskOutcomeFeedbackPrompt,
} from "../TaskOutcomeFeedback";
import type { Doc } from "@/convex/_generated/dataModel";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(),
}));
jest.mock("convex/react", () => ({
  useConvexAuth: jest.fn(() => ({ isAuthenticated: true })),
  useQuery: jest.fn(),
  useMutation: jest.fn(),
}));
import { useQuery, useMutation } from "convex/react";
const survey: Doc<"task_outcome_surveys"> = {
  _id: "survey-1" as Doc<"task_outcome_surveys">["_id"],
  _creationTime: 100,
  user_id: "u",
  request_id: "r",
  chat_id: "c",
  message_id: "m",
  experiment_variant: "test",
  baseline_model: "baseline",
  assigned_model: "treatment",
  mode: "agent",
  subscription_tier: "pro",
  release: "sha",
  selected_at: 100,
  last_interaction_at: 100,
  expires_at: Date.now() + 86400000,
};
let observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void>;
const inView = () =>
  act(() => {
    observers.forEach((callback) => callback([{ isIntersecting: true }]));
  });
const advance = async (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });
describe("unobtrusive task feedback", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    observers = [];
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    global.IntersectionObserver = jest.fn().mockImplementation((callback) => {
      observers.push(callback);
      return { observe: jest.fn(), disconnect: jest.fn() };
    });
  });
  afterEach(() => jest.useRealTimers());
  it("displays a server-selected invitation without browser feature flag fetching", async () => {
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    (useQuery as jest.Mock).mockReturnValue(survey);
    (useMutation as jest.Mock).mockReturnValue(record);
    render(<TaskOutcomeFeedback chatId="c" messageId="m" />);
    inView();
    await advance(15000);
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
  });
  it("waits for fifteen visible seconds and never steals focus", async () => {
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    render(
      <>
        <input aria-label="Chat input" />
        <TaskOutcomeFeedbackPrompt survey={survey} record={record} />
      </>,
    );
    screen.getByLabelText("Chat input").focus();
    await advance(20000);
    expect(record).not.toHaveBeenCalled();
    inView();
    await advance(14999);
    expect(screen.queryByRole("group")).toBeNull();
    await advance(1);
    expect(screen.getByRole("group")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Chat input"));
    expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
    inView();
    expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "task_outcome_survey_shown" }),
    );
  });
  it("waits for a quiet interval after typing", async () => {
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    render(
      <>
        <input aria-label="Draft" />
        <TaskOutcomeFeedbackPrompt survey={survey} record={record} />
      </>,
    );
    inView();
    await advance(10000);
    fireEvent.input(screen.getByLabelText("Draft"), {
      target: { value: "Still composing" },
    });
    await advance(10000);
    expect(record).not.toHaveBeenCalled();
    await advance(5000);
    expect(record).toHaveBeenCalledTimes(1);
  });
  it("does not ask in a hidden tab and restarts the reading delay", async () => {
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    render(<TaskOutcomeFeedbackPrompt survey={survey} record={record} />);
    inView();
    await advance(5000);
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(20000);
    expect(record).not.toHaveBeenCalled();
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(15000);
    expect(screen.getByRole("group")).toBeTruthy();
  });
  it("does not show a prompt already claimed on another device or reload", async () => {
    const record = jest.fn(async () => null);
    const { rerender } = render(
      <TaskOutcomeFeedbackPrompt survey={survey} record={record} />,
    );
    inView();
    await advance(15000);
    expect(screen.queryByRole("group")).toBeNull();
    rerender(
      <TaskOutcomeFeedbackPrompt
        key="reload"
        survey={{ ...survey, shown_at: Date.now() }}
        record={record}
      />,
    );
    inView();
    await advance(15000);
    expect(record).toHaveBeenCalledTimes(1);
  });
  it("saves the answer before optional reasons and records only structured context", async () => {
    const record = jest.fn(async (args: any) => ({
      ...survey,
      shown_at: Date.now(),
      ...(args.answer && { answer: args.answer }),
      ...(args.reason && { answer: "partly" as const, reason: args.reason }),
    }));
    render(<TaskOutcomeFeedbackPrompt survey={survey} record={record} />);
    inView();
    await advance(15000);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Partly" })),
    );
    expect(record).toHaveBeenLastCalledWith({
      id: survey._id,
      action: "answered",
      answer: "partly",
    });
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Didn’t work" })),
    );
    expect(screen.getByText("Thanks for the feedback.")).toBeTruthy();
    expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_outcome_survey_reason",
        properties: expect.objectContaining({
          reason: "did_not_work",
          experiment_request_id: "r",
          experiment_variant: "test",
        }),
      }),
    );
  });
  it("lets users dismiss immediately without answering", async () => {
    const record = jest.fn(async (args: any) => ({
      ...survey,
      shown_at: Date.now(),
      ...(args.action === "dismissed" && { dismissed_at: Date.now() }),
    }));
    render(<TaskOutcomeFeedbackPrompt survey={survey} record={record} />);
    inView();
    await advance(15000);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Dismiss task feedback" }),
      ),
    );
    expect(screen.queryByRole("group")).toBeNull();
    expect(record).toHaveBeenLastCalledWith({
      id: survey._id,
      action: "dismissed",
    });
  });
});
