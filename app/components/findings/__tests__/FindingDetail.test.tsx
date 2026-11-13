import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/findings",
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ closeSidebar: jest.fn(), setChatMode: jest.fn() }),
}));
jest.mock("@/app/contexts/ComposerState", () => ({
  useComposerActions: () => ({ getInput: () => "", setInput: jest.fn() }),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));
const mockCapture = jest.fn();
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  useMutation,
  resetMockConvexQueries,
  setMockQueryResult,
} from "convex/react";
import { toast } from "sonner";
import type { FindingDetailRecord } from "@/types/finding";

jest.mock("@/lib/utils/file-download", () => ({
  downloadFile: jest.fn<any>().mockResolvedValue({ outcome: "success" }),
}));
const { downloadFile } =
  require("@/lib/utils/file-download") as typeof import("@/lib/utils/file-download");
import { renderFindingMarkdown } from "@/lib/findings/markdown";

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

const openReport = () =>
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Report" }));
const openMore = () =>
  userEvent.click(screen.getByRole("button", { name: "More actions" }));

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

  it("renders correction provenance and clears an old revision's feedback", () => {
    const { rerender } = render(
      <FindingDetail
        finding={{
          ...finding,
          usefulness_feedback: {
            answer: "useful",
            report_updated_at: 1,
            submitted_at: 2,
          },
        }}
      />,
    );
    openReport();
    expect(
      screen.getByRole("button", { name: "Useful and reproducible" }),
    ).toHaveAttribute("aria-pressed", "true");
    rerender(
      <FindingDetail
        finding={{
          ...finding,
          updated_at: 3,
          usefulness_feedback: {
            answer: "useful",
            report_updated_at: 1,
            submitted_at: 2,
          },
          correction_count: 1,
          correction_history: [
            {
              updated_at: 3,
              message_id: "correction-message",
              reason: "Narrow the supported impact",
              changed_fields: ["impact"],
              previous_severity: "high",
              severity: "medium",
              previous_cvss_score: 7.1,
              cvss_score: 4.3,
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Useful and reproducible" }),
    ).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByText("Correction history (1)"));
    expect(screen.getByText("Narrow the supported impact")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View correction message" }),
    ).toHaveAttribute("href", expect.stringContaining("correction-message"));
  });

  it("submits feedback for the viewed revision and displays a stale rejection", async () => {
    const mutate = useMutation({} as any) as jest.Mock;
    mutate.mockResolvedValue({ success: false, error: "conflict" });
    const feedbackErrorToast = jest.spyOn(toast, "error");
    render(<FindingDetail finding={finding} />);
    openReport();
    fireEvent.click(screen.getByRole("button", { name: "Needs correction" }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        findingId: "finding-1",
        expectedUpdatedAt: 1,
        answer: "needs_correction",
      }),
    );
    await waitFor(() =>
      expect(feedbackErrorToast).toHaveBeenCalledWith(
        "This report changed. Review the latest version before rating it.",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Needs correction" }),
    ).toHaveAttribute("aria-pressed", "false");
    feedbackErrorToast.mockRestore();
  });

  it("opens on a short overview and keeps the complete report one tab away", () => {
    render(<FindingDetail finding={finding} surface="findings_page" />);
    expect(screen.getByRole("heading", { name: finding.title })).toBeVisible();
    expect(screen.getByText("Access Control / IDOR")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    // The agent-reported evidence basis stays visible as quiet header text.
    expect(screen.getByText("Not recorded")).toHaveAttribute(
      "title",
      expect.stringContaining("not independent verification"),
    );
    expect(
      screen.getByText("https://app.example.test", { exact: false }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("heading", { name: "Summary" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Impact" })).toBeVisible();
    expect(screen.getByText(finding.description)).toBeVisible();
    // Long report sections are not on the default view.
    expect(screen.queryByRole("heading", { name: "Root Cause" })).toBeNull();
    expect(screen.queryByText(finding.poc_script_code)).toBeNull();

    openReport();
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
    openReport();

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

  it("omits management controls in the chat sidebar", async () => {
    render(<FindingDetail finding={finding} surface="computer_sidebar" />);
    openReport();

    expect(
      screen.queryByRole("link", {
        name: "Open source message in Invoice test",
      }),
    ).toBeNull();
    expect(screen.queryByText("Invoice test")).toBeNull();
    await openMore();
    expect(
      screen.queryByRole("menuitem", { name: /Close finding/ }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /source/ })).toBeNull();
  });

  it("copies the PoC and CVSS vector", async () => {
    render(<FindingDetail finding={finding} />);
    openReport();

    fireEvent.click(screen.getByRole("button", { name: "Copy PoC" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy CVSS vector" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenNthCalledWith(1, finding.poc_script_code);
      expect(writeText).toHaveBeenNthCalledWith(2, finding.cvss_vector);
    });
  });

  it("preserves evidence payload characters in the UI and Markdown download", () => {
    const evidence =
      'GET /eval?s=__import__("os") HTTP/1.1\nHost: lab.example.test\n\nHTTP/1.1 200 OK\n{"value":"literal\\n","html":"<b>raw</b>"}\n```\n# not a heading';
    const saved = { ...finding, evidence };
    render(<FindingDetail finding={saved} />);
    openReport();
    const section = screen.getByRole("region", {
      name: "Observed Evidence",
      exact: true,
    });
    expect(section.querySelector("pre code")?.textContent).toBe(evidence);
    expect(section.querySelector("b")).toBeNull();
    expect(within(section).queryByTestId("streamdown")).toBeNull();
    const exported = renderFindingMarkdown(saved);
    expect(exported).toContain(
      `## Evidence\n\n\`\`\`\`\n${evidence}\n\`\`\`\``,
    );
  });

  it("requires a resolution and context, then preserves the closed finding", async () => {
    const mutation = useMutation({} as any) as jest.Mock;
    mutation.mockResolvedValue({ closed: true, closed_at: 2 });
    render(<FindingDetail finding={finding} surface="findings_page" />);

    await openMore();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Close finding/ }),
    );
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
    await waitFor(() =>
      expect(screen.getAllByText("Closed").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("False positive")).toBeVisible();
    expect(
      screen.getByText("Could not reproduce after validating tenant scope."),
    ).toBeVisible();
    await openMore();
    expect(
      screen.queryByRole("menuitem", { name: /Close finding/ }),
    ).toBeNull();
  });

  it("dismisses closure and explains when the finding was deleted concurrently", async () => {
    const mutation = useMutation({} as any) as jest.Mock;
    mutation.mockResolvedValue({ closed: false, not_found: true });
    const errorToast = jest.spyOn(toast, "error");
    render(<FindingDetail finding={finding} surface="findings_page" />);
    await openMore();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Close finding/ }),
    );
    fireEvent.change(screen.getByLabelText(/Closure note/), {
      target: { value: "Retest complete." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close finding" }));
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("This finding no longer exists."),
    );
    expect(screen.queryByRole("heading", { name: "Close finding" })).toBeNull();
    expect(screen.queryByText("Closed")).toBeNull();
    errorToast.mockRestore();
  });

  it("renders loading and deleted states", () => {
    const { rerender } = render(<FindingDetail finding={undefined as any} />);
    expect(screen.getByText("Loading finding…")).toBeVisible();
    rerender(<FindingDetail finding={null} />);
    expect(screen.getByText("Finding deleted")).toBeVisible();
  });
});

it("downloads the saved report in the sidebar without another investigation", async () => {
  render(<FindingDetail finding={finding} surface="computer_sidebar" />);
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Markdown/ }));
  await waitFor(() => expect(downloadFile).toHaveBeenCalled());
  expect(downloadFile).toHaveBeenCalledWith({
    filename: "finding-finding-1.md",
    content: expect.stringContaining(renderFindingMarkdown(finding)),
    mimeType: "text/markdown;charset=utf-8",
  });
});
it("preserves evidence, patches and closure in Markdown, including embedded code fences", () => {
  const poc = "print('example')\n```\n# embedded text\n````";
  const report = renderFindingMarkdown({
    ...finding,
    poc_script_code: poc,
    status: "closed",
    closure_reason: "already_fixed",
    closure_context: "Retested the owner predicate",
    closed_at: 2,
  });
  for (const text of [
    finding.title,
    finding.evidence,
    finding.impact,
    finding.remediation_steps,
    finding.code_locations![0].fix_before!,
    finding.code_locations![0].fix_after!,
    "Retested the owner predicate",
  ])
    expect(report).toContain(text);
  expect(report).toContain("`````\n" + poc + "\n`````");
  expect(report).not.toContain(finding.message_id);
});

it("shows and exports saved verification gaps without calling them checked", () => {
  const warning = "The evidence service was unavailable.";
  const saved = {
    ...finding,
    evidence_refs: ["/tmp/control.http"],
    evidence_verification: {
      checked_refs: ["/tmp/control.http"],
      unavailable_refs: ["/tmp/exploit.http"],
      warning,
    },
  };
  render(<FindingDetail finding={saved} />);
  openReport();
  expect(screen.getByText("Evidence verification incomplete")).toBeVisible();
  expect(screen.getByText(warning)).toBeVisible();
  expect(renderFindingMarkdown(saved)).toContain(warning);
  expect(renderFindingMarkdown(saved)).toContain("/tmp/exploit.http");
});

it("shows assessment limits and includes them in the downloaded report", async () => {
  const saved = {
    ...finding,
    confidence: "medium" as const,
    counterevidence: "Control requests were denied.",
    severity_change_conditions: "Broader access would increase the impact.",
  };
  render(<FindingDetail finding={saved} />);
  openReport();
  expect(screen.getByText(saved.counterevidence)).toBeVisible();
  expect(screen.getByText(saved.severity_change_conditions)).toBeVisible();
  expect(screen.getByText("medium", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Markdown/ }));
  await waitFor(() => expect(downloadFile).toHaveBeenCalled());
  expect(downloadFile).toHaveBeenLastCalledWith(
    expect.objectContaining({
      content: expect.stringContaining(saved.counterevidence),
    }),
  );
});

it("does not infer confidence for an older saved report", () => {
  render(<FindingDetail finding={finding} />);
  openReport();
  expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(1);
  expect(renderFindingMarkdown(finding)).toContain(
    "Assessment confidence: Not recorded",
  );
});

describe("Agent check rollouts", () => {
  const hunts = {
    enabled: true,
    chat_title: "Invoice test",
    hunts: [
      {
        hunt_id: "h1",
        chat_id: "chat-1",
        assistant_message_id: "message-9",
        status: "finished",
        started_at: Date.now() - 60_000,
        finished_at: Date.now() - 30_000,
        summary: "Two sibling invoice endpoints share the gap.",
        limitations: ["Export needs an admin account."],
        candidates: ["pdf", "memo"].map((key) => ({
          candidate_key: key,
          surface: `GET /api/invoices/{id}/${key}`,
          rationale: "Same loader.",
          outcome: "reproduced",
          evidence_basis: "runtime_check",
          reproduction_steps: ["Read tester B's record as tester A"],
          observed_result: "200",
          expected_result: "403",
          evidence_refs: [],
          limitations: [],
          recorded_at: 1,
        })),
      },
    ],
  };
  const retests = {
    enabled: true,
    chat_title: "Invoice test",
    retests: [
      {
        retest_id: "r1",
        chat_id: "chat-1",
        assistant_message_id: "message-2",
        status: "finished",
        started_at: Date.now() - 90_000,
        outcome: "reproduced",
        summary: "Still reproduces.",
      },
    ],
  };
  const respond = (routes: { hunts: unknown; retests: unknown }) =>
    jest.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.startsWith("/api/finding-hunts") ? routes.hunts : routes.retests,
    }));

  beforeEach(() => mockCapture.mockClear());
  afterEach(() => {
    delete (global as any).fetch;
  });

  it("shows hunt results behind one header action, a compact check and its tab", async () => {
    (global as any).fetch = respond({ hunts, retests });
    render(<FindingDetail finding={finding} surface="findings_page" />);
    expect(
      await screen.findByRole("button", { name: "Hunt similar" }),
    ).toBeEnabled();
    expect(screen.getByRole("tab", { name: /Similar issues/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Retests/ })).toBeVisible();
    const checks = screen.getByRole("heading", {
      name: "Agent checks",
    }).parentElement!;
    expect(within(checks).getByText("2 reproduced")).toBeVisible();
    // Results stay compact until the tab is opened.
    expect(screen.queryByText("GET /api/invoices/{id}/pdf")).toBeNull();

    fireEvent.click(
      within(checks).getByRole("button", { name: "Open Similar issues" }),
    );
    expect(screen.getByRole("tab", { name: /Similar issues/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByText("Two sibling invoice endpoints share the gap."),
    ).toBeVisible();
    expect(screen.getByText("GET /api/invoices/{id}/pdf")).toBeVisible();
    // The tab has no second hunt CTA.
    expect(screen.getAllByRole("button", { name: /Hunt/ })).toHaveLength(1);

    const exposures = mockCapture.mock.calls.filter(
      ([event]) => event === "finding_hunt_section_viewed",
    );
    expect(exposures).toEqual([
      [
        "finding_hunt_section_viewed",
        { surface: "findings_page", hunt_count: 1 },
      ],
    ]);
  });

  it("opens another finding on Overview and counts its exposure once", async () => {
    (global as any).fetch = respond({ hunts, retests });
    const { rerender } = render(<FindingDetail finding={finding} />);
    await screen.findByRole("tab", { name: /Similar issues/ });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Similar issues/ }));
    rerender(<FindingDetail finding={{ ...finding, updated_at: 2 }} />);
    // A refreshed revision of the same finding keeps the open tab.
    expect(screen.getByRole("tab", { name: /Similar issues/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    rerender(
      <FindingDetail finding={{ ...finding, finding_id: "finding-2" }} />,
    );
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(
        mockCapture.mock.calls.filter(
          ([event]) => event === "finding_hunt_section_viewed",
        ),
      ).toHaveLength(2),
    );
  });

  it("hides hunt controls, tab and exposure when the rollout is off", async () => {
    (global as any).fetch = respond({ hunts: { enabled: false }, retests });
    render(<FindingDetail finding={finding} />);
    expect(await screen.findByRole("tab", { name: /Retests/ })).toBeVisible();
    expect(screen.queryByRole("tab", { name: /Similar issues/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Hunt/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Similar issues" }),
    ).toBeNull();
    expect(
      mockCapture.mock.calls.some(
        ([event]) => event === "finding_hunt_section_viewed",
      ),
    ).toBe(false);
  });
});

describe("finding query recovery", () => {
  afterEach(() => resetMockConvexQueries());

  it("contains query errors in the report panel and recovers the saved finding", () => {
    setMockQueryResult(new Error("Function execution timed out"));
    const onRequestClose = jest.fn();
    const { rerender } = render(
      <div>
        <p>Completed chat remains visible</p>
        <FindingDetail findingId="finding-1" onRequestClose={onRequestClose} />
      </div>,
    );
    expect(screen.getByText("Completed chat remains visible")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load finding",
    );
    expect(screen.queryByText("Finding deleted")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload report" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    setMockQueryResult(finding);
    rerender(<FindingDetail findingId="finding-1" />);
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
