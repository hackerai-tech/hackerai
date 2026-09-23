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
  survey_kind: "new_paid",
  mode: "agent",
  subscription_tier: "pro",
  release: "sha",
  paid_start_event_id:
    "paid-1" as Doc<"task_outcome_surveys">["paid_start_event_id"],
  paid_started_at: 90,
  stripe_subscription_id: "sub-1",
  paid_start_invoice_id: "in-1",
  selected_at: 100,
  last_interaction_at: 100,
  expires_at: Date.now() + 86400000,
};
let observers: Array<
  (
    entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>,
  ) => void
>;
const inView = (intersectionRatio = 1) =>
  act(async () => {
    observers.forEach((callback) =>
      callback([{ isIntersecting: true, intersectionRatio }]),
    );
  });
describe("unobtrusive task feedback", () => {
  beforeEach(() => {
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
  it("displays a server-selected invitation without browser feature flag fetching", async () => {
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    (useQuery as jest.Mock).mockReturnValue(survey);
    (useMutation as jest.Mock).mockReturnValue(record);
    render(<TaskOutcomeFeedback chatId="c" messageId="m" />);
    await inView();
    expect(screen.getByRole("button", { name: "Solved my task" })).toBeTruthy();
  });
  it("shows immediately in view without stealing focus or adding a timer", async () => {
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    render(
      <>
        <input aria-label="Chat input" />
        <TaskOutcomeFeedbackPrompt survey={survey} record={record} />
      </>,
    );
    screen.getByLabelText("Chat input").focus();
    expect(record).not.toHaveBeenCalled();
    await inView();
    expect(screen.getByRole("group")).toBeTruthy();
    expect(screen.getByText("Did this help?")).toBeTruthy();
    expect(screen.queryByText("Optional")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Haven’t checked" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Chat input"));
    expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
    await inView();
    expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_outcome_survey_shown",
        properties: expect.objectContaining({ survey_ui_version: 4 }),
      }),
    );
  });
  it("does not claim in a hidden tab, then shows as soon as it becomes visible", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    render(<TaskOutcomeFeedbackPrompt survey={survey} record={record} />);
    await inView();
    expect(record).not.toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByRole("group")).toBeTruthy();
  });
  it("requires a fully visible footer to claim and half the question to count a view", async () => {
    const record = jest.fn(async () => ({ ...survey, shown_at: Date.now() }));
    render(<TaskOutcomeFeedbackPrompt survey={survey} record={record} />);
    await inView(0);
    await inView(0.5);
    expect(record).not.toHaveBeenCalled();
    await inView(1);
    expect(record).toHaveBeenCalledTimes(1);
    await inView(0.2);
    expect(captureQueuedAuthenticatedEvent).not.toHaveBeenCalled();
    await inView(0.5);
    expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "task_outcome_survey_shown" }),
    );
  });
  it("does not show a prompt already claimed on another device or reload", async () => {
    const record = jest.fn(async () => null);
    const { rerender } = render(
      <TaskOutcomeFeedbackPrompt survey={survey} record={record} />,
    );
    await inView();
    expect(screen.queryByRole("group")).toBeNull();
    rerender(
      <TaskOutcomeFeedbackPrompt
        key="reload"
        survey={{ ...survey, shown_at: Date.now() }}
        record={record}
      />,
    );
    await inView();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it("saves the answer before optional reasons and records only structured context", async () => {
    const record = jest.fn(async (args: any) => ({
      ...survey,
      shown_at: Date.now(),
      ...(args.answer && { answer: args.answer }),
      ...(args.reason && { answer: "helpful" as const, reason: args.reason }),
    }));
    render(<TaskOutcomeFeedbackPrompt survey={survey} record={record} />);
    await inView();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Helpful, still working" }),
      ),
    );
    expect(record).toHaveBeenLastCalledWith({
      id: survey._id,
      action: "answered",
      answer: "helpful",
    });
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Clear explanation" }),
      ),
    );
    expect(screen.getByText("Thanks for your feedback")).toBeTruthy();
    expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_outcome_survey_reason",
        properties: expect.objectContaining({
          reason: "clear_explanation",
          survey_kind: "new_paid",
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
    await inView();
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
  it.each([
    ["Solved my task", "solved"],
    ["Helpful, still working", "helpful"],
    ["Haven’t checked", "not_checked"],
  ])("records %s separately", async (label, answer) => {
    const record = jest.fn(async (args: any) => ({
      ...survey,
      shown_at: Date.now(),
      ...(args.answer && { answer: args.answer }),
    }));
    render(<TaskOutcomeFeedbackPrompt survey={survey} record={record} />);
    await inView();
    await inView();
    expect(record).toHaveBeenCalledWith({ id: survey._id, action: "viewed" });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: label })),
    );
    expect(record).toHaveBeenLastCalledWith({
      id: survey._id,
      action: "answered",
      answer,
    });
    expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_outcome_survey_answered",
        properties: expect.objectContaining({
          survey_kind: "new_paid",
          answer,
          task_solved: answer === "not_checked" ? null : answer === "solved",
        }),
      }),
    );
    if (answer === "helpful")
      expect(screen.getByText("What helped?")).toBeTruthy();
    else expect(screen.getByText("Thanks for your feedback")).toBeTruthy();
  });
});
