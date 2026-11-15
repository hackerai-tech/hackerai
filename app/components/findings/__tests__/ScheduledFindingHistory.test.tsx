import "@testing-library/jest-dom";
import { describe, expect, it } from "@jest/globals";
import { render, screen, within } from "@testing-library/react";
import type {
  FindingDetailRecord,
  FindingScheduledObservation,
} from "@/types/finding";
import { ScheduledFindingHistory } from "../ScheduledFindingHistory";

const DAY = 86_400_000;
const run = (
  day: number,
  task?: { chatId: string; messageId: string },
): FindingScheduledObservation => ({
  observedAt: Date.UTC(2026, 10, day, 12),
  taskAvailable: Boolean(task),
  ...task,
});

const scheduled = (
  observationCount: number | undefined,
  scheduledObservations: FindingScheduledObservation[] | undefined,
) =>
  ({
    finding_id: "finding-1",
    chat_id: "source-task",
    schedule: { id: "schedule-1", name: "Nightly recon" },
    observationCount,
    scheduledObservations,
  }) as FindingDetailRecord;

describe("ScheduledFindingHistory", () => {
  it.each([
    ["an unscheduled finding", undefined, undefined],
    [
      "the source run alone",
      1,
      [run(6, { chatId: "source-task", messageId: "m1" })],
    ],
  ] as const)("shows nothing for %s", (_case, count, runs) => {
    const { container } = render(
      <ScheduledFindingHistory
        finding={scheduled(count, runs ? [...runs] : undefined)}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stays collapsed, counts every run and lists only the latest returned", () => {
    render(
      <ScheduledFindingHistory
        finding={scheduled(7, [
          run(8, { chatId: "task-8", messageId: "message-8" }),
          run(7),
          run(6, { chatId: "task-6", messageId: "message-6" }),
        ])}
      />,
    );
    const summary = screen.getByText("Reported by 7 scheduled runs");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    const history = within(summary.closest("details")!);
    expect(history.getByText(/Latest 3 of 7 runs\./)).toBeInTheDocument();
    // A repeat report must not read as a retest or a status change.
    expect(
      history.getByText(/don’t change this report’s evidence or status/),
    ).toBeInTheDocument();

    const rows = history.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // Server order is kept: newest first.
    const links = history.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/c/task-8#message=message-8",
      "/c/task-6#message=message-6",
    ]);
    // Each link is told apart by its run time.
    const names = links.map((link) => link.getAttribute("aria-labelledby"));
    expect(new Set(names).size).toBe(2);
    for (const link of links)
      expect(link).toHaveAccessibleName(/^Open task .*2026/);

    // A deleted task keeps its run time but offers nowhere to go.
    expect(within(rows[1]).getByText("Task deleted")).toBeInTheDocument();
    expect(within(rows[1]).queryByRole("link")).toBeNull();
  });

  it("does not claim a partial list when every run is shown", () => {
    render(
      <ScheduledFindingHistory
        finding={scheduled(2, [
          run(8, { chatId: "task-8", messageId: "message-8" }),
          run(7, { chatId: "source-task", messageId: "message-7" }),
        ])}
      />,
    );
    expect(
      screen.getByText("Reported by 2 scheduled runs"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Latest/)).toBeNull();
  });

  it("never links a run whose task is unavailable, even with stale ids", () => {
    render(
      <ScheduledFindingHistory
        finding={scheduled(2, [
          {
            observedAt: Date.UTC(2026, 10, 8, 12),
            taskAvailable: false,
            chatId: "deleted-task",
            messageId: "message-8",
          },
          // An existing task without a message to open is not "deleted".
          { observedAt: Date.UTC(2026, 10, 8, 12) - DAY, taskAvailable: true },
        ])}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getAllByText("Task deleted")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
