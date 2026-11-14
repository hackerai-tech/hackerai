import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FindingExportMenu,
  FindingExportUnavailableError,
} from "../FindingExportMenu";
import { downloadFindingsReport } from "@/lib/findings/export-client";
import { captureFindingEvent } from "@/lib/findings/client-telemetry";
import { toast } from "sonner";
import type { FindingDetailRecord } from "@/types/finding";
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() },
}));
jest.mock("@/lib/findings/export-client", () => ({
  downloadFindingsReport: jest.fn(),
}));
jest.mock("@/lib/findings/client-telemetry", () => ({
  captureFindingEvent: jest.fn(),
}));
const record = { finding_id: "f-1", updated_at: 12 } as FindingDetailRecord;
beforeEach(() => jest.clearAllMocks());
it.each([
  ["Markdown", "markdown"],
  ["PDF", "pdf"],
  ["HTML", "html"],
  ["JSON", "json"],
  ["SARIF 2.1", "sarif"],
])("exports the exact selected records as %s", async (label, format) => {
  jest.mocked(downloadFindingsReport).mockResolvedValue({ outcome: "success" });
  render(<FindingExportMenu getFindings={async () => [record]} />);
  await userEvent.click(screen.getByRole("button", { name: "Export report" }));
  await userEvent.click(
    screen.getByRole("menuitem", { name: new RegExp(label) }),
  );
  await waitFor(() =>
    expect(downloadFindingsReport).toHaveBeenCalledWith([record], format),
  );
  expect(captureFindingEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: "save",
      outcome: "success",
      format,
      result_count: 1,
    }),
  );
});
it("does not export partial selections after an unavailable record", async () => {
  render(
    <FindingExportMenu
      getFindings={async () => {
        throw new FindingExportUnavailableError();
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Export report" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Some findings are no longer available. Nothing was exported.",
    ),
  );
  expect(downloadFindingsReport).not.toHaveBeenCalled();
});
it("blocks a second export and announces progress until the first finishes", async () => {
  let finish!: (value: { outcome: "success" }) => void;
  jest.mocked(downloadFindingsReport).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<FindingExportMenu getFindings={async () => [record]} />);
  await userEvent.click(screen.getByRole("button", { name: "Export report" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /PDF/ }));
  const busyTrigger = await screen.findByRole("button", {
    name: /Exporting…/,
  });
  expect(busyTrigger).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("status")).toHaveTextContent("Preparing export…");
  // The busy trigger doesn't reopen the formats, so nothing starts twice.
  await userEvent.click(busyTrigger);
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  expect(downloadFindingsReport).toHaveBeenCalledTimes(1);

  await act(async () => finish({ outcome: "success" }));
  // Formats become available again once the first export settles.
  expect(screen.getByRole("status")).toHaveTextContent("");
  await userEvent.click(screen.getByRole("button", { name: "Export report" }));
  expect(screen.getAllByRole("menuitem")).toHaveLength(5);
  for (const item of screen.getAllByRole("menuitem"))
    expect(item).not.toHaveAttribute("aria-disabled");
});
it("keeps keyboard focus on the trigger while a keyboard-chosen export is pending", async () => {
  let finish!: (value: { outcome: "success" }) => void;
  jest.mocked(downloadFindingsReport).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<FindingExportMenu getFindings={async () => [record]} />);
  screen.getByRole("button", { name: "Export report" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("menuitem", { name: /Markdown/ })).toHaveFocus();
  await userEvent.keyboard("{Enter}");

  const busyTrigger = await screen.findByRole("button", {
    name: /Exporting…/,
  });
  expect(busyTrigger).toHaveFocus();
  // Enter on the busy trigger neither reopens the menu nor exports again.
  await userEvent.keyboard("{Enter}");
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  expect(downloadFindingsReport).toHaveBeenCalledTimes(1);
  expect(downloadFindingsReport).toHaveBeenCalledWith([record], "markdown");

  await act(async () => finish({ outcome: "success" }));
  expect(screen.getByRole("button", { name: "Export report" })).toHaveFocus();
});
it("records cancellation without calling it a successful export", async () => {
  jest
    .mocked(downloadFindingsReport)
    .mockResolvedValue({ outcome: "canceled" });
  render(<FindingExportMenu getFindings={async () => [record]} />);
  await userEvent.click(screen.getByRole("button", { name: "Export report" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
  await waitFor(() =>
    expect(captureFindingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "canceled", phase: "save" }),
    ),
  );
  expect(toast.error).not.toHaveBeenCalled();
});
