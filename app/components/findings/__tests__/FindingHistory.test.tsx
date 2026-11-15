import "@testing-library/jest-dom";
import { describe, expect, it } from "@jest/globals";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FindingDetailRecord } from "@/types/finding";
import { FindingHistory } from "../FindingHistory";

const revision = {
  reason: "Narrow the supported impact",
  changed_fields: ["impact"],
  previous_severity: "high",
  severity: "medium",
  previous_cvss_score: 7.1,
  cvss_score: 4.3,
};

const withHistory = (
  correction_history: FindingDetailRecord["correction_history"],
) =>
  ({
    finding_id: "finding-1",
    chat_id: "source-task",
    correction_history,
  }) as FindingDetailRecord;

const correctionLinks = () => {
  fireEvent.click(screen.getByText(/^Correction history/));
  return screen
    .getAllByRole("link", { name: "View correction message" })
    .map((link) => link.getAttribute("href"));
};

describe("FindingHistory", () => {
  it("opens a later scheduled run's correction in that run's task", () => {
    render(
      <FindingHistory
        finding={withHistory([
          { ...revision, updated_at: 2, message_id: "first-correction" },
          {
            ...revision,
            updated_at: 3,
            message_id: "later-correction",
            chat_id: "later-run-task",
          },
        ])}
      />,
    );
    // Newest first. Pairing the later message with the source task would
    // open a task that does not contain it.
    expect(correctionLinks()).toEqual([
      "/c/later-run-task#message=later-correction",
      "/c/source-task#message=first-correction",
    ]);
  });

  it("does not send a correction whose task is gone to the source task", () => {
    render(
      <FindingHistory
        finding={withHistory([
          { ...revision, updated_at: 2, message_id: "first-correction" },
          {
            ...revision,
            updated_at: 3,
            message_id: "lost-correction",
            reason: "Corrected by a run whose task was deleted",
            task_available: false,
          },
          {
            ...revision,
            updated_at: 4,
            message_id: "later-correction",
            chat_id: "later-run-task",
          },
        ])}
      />,
    );
    // The source task never held the lost message, so it gets no link at
    // all; its neighbours keep theirs.
    expect(correctionLinks()).toEqual([
      "/c/later-run-task#message=later-correction",
      "/c/source-task#message=first-correction",
    ]);
    const lost = screen
      .getByText("Corrected by a run whose task was deleted")
      .closest("li")!;
    expect(within(lost).queryByRole("link")).toBeNull();
    expect(
      within(lost).getByText("Correction task unavailable"),
    ).toBeInTheDocument();
    // The correction itself is still on record.
    expect(within(lost).getByText(/Changed: impact/)).toBeInTheDocument();
    expect(screen.getAllByText("Correction task unavailable")).toHaveLength(1);
  });

  it("keeps an ordinary correction in the finding's source task", () => {
    render(
      <FindingHistory
        finding={withHistory([
          { ...revision, updated_at: 2, message_id: "correction" },
        ])}
      />,
    );
    expect(correctionLinks()).toEqual(["/c/source-task#message=correction"]);
  });
});
