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
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Exporting…/ })).toBeDisabled(),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Preparing export…");
  // Every format is disabled while busy, and a second selection does nothing.
  const items = screen.queryAllByRole("menuitem");
  for (const item of items)
    expect(item).toHaveAttribute("aria-disabled", "true");
  if (items[0]) await userEvent.click(items[0]);
  await userEvent.click(screen.getByRole("button", { name: /Exporting…/ }));
  expect(downloadFindingsReport).toHaveBeenCalledTimes(1);

  await act(async () => finish({ outcome: "success" }));
  // Formats become available again once the first export settles.
  expect(screen.getAllByRole("menuitem")).toHaveLength(5);
  for (const item of screen.getAllByRole("menuitem"))
    expect(item).not.toHaveAttribute("aria-disabled");
  expect(screen.getByRole("status")).toHaveTextContent("");
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
