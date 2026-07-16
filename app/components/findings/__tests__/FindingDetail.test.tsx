import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMutation } from "convex/react";
import type { FindingDetailRecord } from "@/types/finding";

const mockCapture = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCapture,
}));

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
      fix_before: "where: { id }",
      fix_after: "where: { id, userId }",
    },
  ],
};

describe("FindingDetail", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders the complete report and source chat link", () => {
    render(<FindingDetail finding={finding} />);
    expect(screen.getByRole("heading", { name: finding.title })).toBeVisible();
    expect(screen.getByText("CWE-639")).toBeVisible();
    expect(screen.getByText(finding.poc_script_code)).toBeVisible();
    expect(screen.getByText(finding.evidence)).toBeVisible();
    expect(screen.getByText("app/api/invoices/route.ts:20-22")).toBeVisible();
    expect(screen.getByRole("link", { name: /Invoice test/i })).toHaveAttribute(
      "href",
      "/c/chat-1",
    );
  });

  it("requires confirmation, deletes, and emits only surface analytics", async () => {
    const mutation = useMutation({} as any) as jest.Mock;
    mutation.mockResolvedValue({ deleted: true });
    const onDeleted = jest.fn();
    render(
      <FindingDetail
        finding={finding}
        surface="findings_page"
        onDeleted={onDeleted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this finding?")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete finding" }));

    await waitFor(() => {
      expect(mutation).toHaveBeenCalledWith({ findingId: "finding-1" });
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
    expect(mockCapture).toHaveBeenCalledWith("finding_deleted", {
      surface: "findings_page",
    });
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(
      /Confirmed IDOR|app\.example|HTTP 200|curl/,
    );
  });

  it("renders loading and deleted states", () => {
    const { rerender } = render(<FindingDetail finding={undefined as any} />);
    expect(screen.getByText("Loading finding…")).toBeVisible();
    rerender(<FindingDetail finding={null} />);
    expect(screen.getByText("Finding deleted")).toBeVisible();
  });
});
