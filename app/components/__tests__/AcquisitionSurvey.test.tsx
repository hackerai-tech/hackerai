import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ACQUISITION_SURVEY_STORAGE_KEY } from "@/lib/analytics/acquisition-survey";

const mockCaptureQueuedAuthenticatedEvent = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/analytics/client", () => ({
  captureQueuedAuthenticatedEvent: (...args: unknown[]) =>
    mockCaptureQueuedAuthenticatedEvent(...args),
}));

const { AcquisitionSurvey } =
  require("../AcquisitionSurvey") as typeof import("../AcquisitionSurvey");

describe("AcquisitionSurvey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ available: true }),
    } as never);
  });

  it("checks availability only after a successful run becomes eligible", async () => {
    const { rerender } = render(
      <AcquisitionSurvey eligible={false} activationMode="ask" />,
    );

    expect(mockFetch).not.toHaveBeenCalled();

    rerender(<AcquisitionSurvey eligible activationMode="ask" />);

    expect(
      await screen.findByRole("heading", {
        name: "Help us improve discovery",
      }),
    ).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/experiments/acquisition-survey",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(mockCaptureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "acquisition_survey_shown" }),
    );
  });

  it("submits only structured answers and does not ask for free text", async () => {
    render(<AcquisitionSurvey eligible activationMode="agent" />);

    const firstHeard = await screen.findByLabelText(
      "Where did you first hear about HackerAI?",
    );
    const mainReason = screen.getByLabelText(
      "What was your main reason for trying it?",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.change(firstHeard, { target: { value: "ai_assistant" } });
    fireEvent.change(mainReason, { target: { value: "security_agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(mockCaptureQueuedAuthenticatedEvent).toHaveBeenCalledWith({
        event: "acquisition_survey_submitted",
        dedupeKey: "hac_57_post_activation_v1",
        properties: expect.objectContaining({
          survey_id: "hac_57_post_activation_v1",
          answer_source: "post_activation_survey",
          activation_mode: "agent",
          first_heard_source: "ai_assistant",
          main_reason: "security_agent",
          $set_once: expect.objectContaining({
            acquisition_survey_first_heard: "ai_assistant",
            acquisition_survey_main_reason: "security_agent",
          }),
        }),
      });
    });
    expect(window.localStorage.getItem(ACQUISITION_SURVEY_STORAGE_KEY)).toBe(
      "submitted",
    );
  });

  it("still closes and captures when browser storage is unavailable", async () => {
    const storageSpy = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Storage is blocked", "SecurityError");
      });

    try {
      render(<AcquisitionSurvey eligible activationMode="ask" />);

      fireEvent.change(
        await screen.findByLabelText(
          "Where did you first hear about HackerAI?",
        ),
        { target: { value: "ai_assistant" } },
      );
      fireEvent.change(
        screen.getByLabelText("What was your main reason for trying it?"),
        { target: { value: "security_agent" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));

      await waitFor(() => {
        expect(
          screen.queryByRole("heading", {
            name: "Help us improve discovery",
          }),
        ).not.toBeInTheDocument();
      });
      expect(mockCaptureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: "acquisition_survey_submitted" }),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });
});
