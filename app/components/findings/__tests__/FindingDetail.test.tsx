import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMutation } from "convex/react";
import type { FindingDetailRecord } from "@/types/finding";

Object.defineProperty(global, "ResizeObserver", {
  configurable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

const { FindingDetail } =
  require("../FindingDetail") as typeof import("../FindingDetail");

const finding: FindingDetailRecord = {
  finding_id: "finding-1",
  title: "Confirmed IDOR",
  target: "https://app.example.test",
  endpoint: "/api/invoices/other",
  method: "GET",
  severity: "high",
  cvss_score: 7.1,
  category: "access_control",
  status: "active",
  chat_id: "chat-1",
  chat_title: "Invoice test",
  created_at: 1,
  updated_at: 1,
  message_id: "message-1",
  description: "Another account's invoice is readable.",
  impact: "Billing data disclosure.",
  technical_analysis: "The handler omits an owner predicate.",
  poc_description: "Request another account's invoice.",
  poc_script_code: "curl /api/invoices/other",
  remediation_steps: "Add an owner predicate.",
  evidence: "HTTP 200 returned the other account's data.",
  assumptions: "Ordinary authenticated account.",
  fix_effort: "low",
  cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
  cvss_breakdown: {
    attack_vector: "N",
    attack_complexity: "L",
    privileges_required: "L",
    user_interaction: "N",
    scope: "U",
    confidentiality: "H",
    integrity: "N",
    availability: "N",
  },
  cwe: "CWE-639",
  code_locations: [
    {
      file: "app/api/invoices/route.ts",
      start_line: 20,
      end_line: 22,
      label: "Missing ownership predicate",
      snippet: "findUnique({ id })",
      fix_before:
        "const invoice = await db.invoice.findUnique({\n  where: { id },\n});",
      fix_after:
        "const invoice = await db.invoice.findUnique({\n  where: { id, userId },\n});",
    },
  ],
};

describe("FindingDetail", () => {
  const writeText = jest.fn<() => Promise<void>>();

  beforeEach(() => {
    jest.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("renders the complete report and source chat link", () => {
    render(<FindingDetail finding={finding} surface="findings_page" />);
    expect(screen.getByRole("heading", { name: finding.title })).toBeVisible();
    expect(screen.getByText("Confirmed Vulnerability")).toBeVisible();
    expect(screen.getByText("Access Control / IDOR")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Summary" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Impact" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Root Cause" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Validation" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Observed Evidence" }),
    ).toBeVisible();
    expect(screen.getByText("Fix Effort")).toBeVisible();
    expect(screen.getByText("CWE-639")).toBeVisible();
    expect(screen.getByText(finding.poc_script_code)).toBeVisible();
    expect(screen.getByText(finding.evidence)).toBeVisible();
    expect(
      screen.getAllByText("app/api/invoices/route.ts:20-22")[0],
    ).toBeVisible();
    expect(screen.getByText("Source Reference")).toBeVisible();
    expect(screen.getByText("Read-only Guidance")).toBeVisible();
    expect(screen.getByText("Current Code")).toBeVisible();
    expect(screen.getByText("Suggested Change")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Assessment Details" }),
    ).toBeVisible();
    expect(screen.getByText("Network")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Why this severity\?/ }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("link", {
        name: "Open source message in Invoice test",
      }),
    ).toHaveAttribute("href", "/c/chat-1#message=message-1");
  });

  it("explains the CVSS metrics in plain language on request", () => {
    render(<FindingDetail finding={finding} />);

    expect(screen.queryByText("Reachable over a network")).toBeNull();

    const trigger = screen.getByRole("button", {
      name: /Why this severity\?/,
    });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reachable over a network")).toBeVisible();
    expect(screen.getByText("Requires basic user privileges")).toBeVisible();
    expect(
      screen.getByText(
        "Broad or critical confidential information can be exposed",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("No integrity impact was demonstrated"),
    ).toBeVisible();
  });

  it("omits management controls in the chat sidebar", () => {
    render(<FindingDetail finding={finding} surface="computer_sidebar" />);

    expect(
      screen.queryByRole("link", {
        name: "Open source message in Invoice test",
      }),
    ).toBeNull();
    expect(screen.queryByText("Invoice test")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Finding" })).toBeNull();
  });

  it("copies the PoC and CVSS vector", async () => {
    render(<FindingDetail finding={finding} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy PoC" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy CVSS vector" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenNthCalledWith(1, finding.poc_script_code);
      expect(writeText).toHaveBeenNthCalledWith(2, finding.cvss_vector);
    });
  });

  it("requires a resolution and context, then preserves the closed finding", async () => {
    const mutation = useMutation({} as any) as jest.Mock;
    mutation.mockResolvedValue({ closed: true, closed_at: 2 });
    render(<FindingDetail finding={finding} surface="findings_page" />);

    fireEvent.click(screen.getByRole("button", { name: "Close Finding" }));
    expect(
      screen.getByRole("heading", { name: "Close finding" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Already fixed")).toBeChecked();
    expect(screen.queryByText("The issue is fixed and retested.")).toBeNull();
    expect(screen.queryByText("The risk is accepted for now.")).toBeNull();
    expect(
      screen.queryByText("The issue is not valid or reproducible."),
    ).toBeNull();
    fireEvent.click(screen.getByLabelText("False positive"));
    fireEvent.change(screen.getByLabelText(/Closure note/), {
      target: { value: "Could not reproduce after validating tenant scope." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close finding" }));

    await waitFor(() => {
      expect(mutation).toHaveBeenCalledWith({
        findingId: "finding-1",
        reason: "false_positive",
        context: "Could not reproduce after validating tenant scope.",
      });
    });
    expect(screen.getAllByText("Closed").length).toBeGreaterThan(0);
    expect(screen.getByText("False positive")).toBeVisible();
    expect(
      screen.getByText("Could not reproduce after validating tenant scope."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close Finding" })).toBeNull();
  });

  it("renders loading and deleted states", () => {
    const { rerender } = render(<FindingDetail finding={undefined as any} />);
    expect(screen.getByText("Loading finding…")).toBeVisible();
    rerender(<FindingDetail finding={null} />);
    expect(screen.getByText("Finding deleted")).toBeVisible();
  });
});
