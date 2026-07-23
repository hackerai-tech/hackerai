import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockUsePaginatedQuery = jest.fn();
const mockUseQuery = jest.fn((_ref: unknown, args: any) =>
  args?.findingId ? mockFinding : undefined,
);
const mockConvexQuery = jest.fn();
const mockDownloadFile = jest.fn();
const mockCapture = jest.fn();
const mockPush = jest.fn();
const mockSearchParams = new URLSearchParams();
const mockCloseSidebar = jest.fn();
const mockInitializeNewChat = jest.fn();
const mockSetChatMode = jest.fn();
const mockSetTemporaryChatsEnabled = jest.fn();

jest.mock("convex/react", () => ({
  useConvex: () => ({ query: mockConvexQuery }),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: (...args: unknown[]) => mockUsePaginatedQuery(...args),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => jest.fn(),
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    setChatSidebarOpen: jest.fn(),
    closeSidebar: mockCloseSidebar,
    initializeNewChat: mockInitializeNewChat,
    setChatMode: mockSetChatMode,
    setTemporaryChatsEnabled: mockSetTemporaryChatsEnabled,
  }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

jest.mock("@/app/hooks/useTauri", () => ({ navigateToAuth: jest.fn() }));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCapture,
}));
jest.mock("@/lib/utils/file-download", () => ({
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
}));

const mockFinding = {
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
  created_at: Date.now(),
  updated_at: Date.now(),
  message_id: "message-1",
  description: "Another account's invoice is readable.",
  impact: "Billing data disclosure.",
  technical_analysis: "Missing owner predicate.",
  poc_description: "Request another account's invoice.",
  poc_script_code: "curl /api/invoices/other",
  remediation_steps: "Add an owner predicate.",
  evidence: "HTTP 200 returned another account's data.",
  assumptions: "Ordinary account.",
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
};

const Page = require("../page").default as typeof import("../page").default;

describe("FindingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    window.history.replaceState({}, "", "/findings");
    mockUseQuery.mockImplementation((_ref: unknown, args: any) =>
      args?.findingId ? mockFinding : undefined,
    );
    mockUsePaginatedQuery.mockReturnValue({
      results: [mockFinding],
      status: "Exhausted",
      loadMore: jest.fn(),
    });
    mockConvexQuery.mockResolvedValue({
      page: [mockFinding],
      isDone: true,
      continueCursor: "",
    });
    mockDownloadFile.mockResolvedValue(undefined);
  });

  it("lists metadata and searches without a source-chat filter", async () => {
    render(<Page />);
    expect(screen.getByRole("heading", { name: "Findings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveClass(
      "md:hidden",
    );
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();
    expect(screen.queryByText("/api/invoices/other")).toBeNull();
    expect(screen.getByText("7.1")).toBeVisible();
    expect(screen.getByTestId("finding-severity-dot-finding-1")).toHaveClass(
      "bg-orange-500",
    );
    expect(screen.getByText("Current Results")).toBeVisible();
    expect(screen.queryByText("Validation Standard")).toBeNull();
    expect(screen.queryByText("Evidence + working PoC")).toBeNull();
    expect(screen.queryByText("Endpoint")).toBeNull();
    expect(screen.queryByText("Source Chat")).toBeNull();
    expect(screen.getAllByText("Category").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Status").length).toBeGreaterThan(0);
    expect(screen.getByText("Access Control / IDOR")).toBeVisible();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: "Findings" })).toBeVisible();
    expect(screen.getByLabelText("Filter by category")).toBeVisible();
    expect(screen.getByLabelText("Filter by status")).toBeVisible();
    expect(screen.getByLabelText("Filter by severity")).toBeVisible();
    expect(screen.queryByLabelText("Filter by source chat")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Export findings as CSV" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Start new scan" }),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Search findings"), {
      target: { value: "CWE-639" },
    });
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ search: "CWE-639" }),
        { initialNumItems: 25 },
      );
    });
    expect(screen.getByText("Best matches for “CWE-639”")).toBeVisible();
    expect(window.location.search).toBe("?q=CWE-639");

    fireEvent.change(screen.getByLabelText("Search findings"), {
      target: { value: "" },
    });
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(mockCapture).toHaveBeenCalledWith("findings_page_viewed");
  });

  it("filters by category and lifecycle status", async () => {
    render(<Page />);

    fireEvent.click(screen.getByLabelText("Filter by category"));
    fireEvent.click(screen.getByRole("option", { name: "Injection" }));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ category: "injection" }),
        { initialNumItems: 25 },
      );
    });

    fireEvent.click(screen.getByLabelText("Filter by status"));
    fireEvent.click(screen.getByRole("option", { name: "Closed" }));
    await waitFor(() => {
      expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          category: "injection",
          status: "closed",
        }),
        { initialNumItems: 25 },
      );
    });
    expect(window.location.search).toContain("category=injection");
    expect(window.location.search).toContain("status=closed");
  });

  it("exports the complete filtered summary as CSV", async () => {
    render(<Page />);

    fireEvent.click(
      screen.getByRole("button", { name: "Export findings as CSV" }),
    );

    await waitFor(() => {
      expect(mockConvexQuery).toHaveBeenCalledWith(expect.anything(), {
        paginationOpts: { cursor: null, numItems: 25 },
      });
      expect(mockDownloadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: expect.stringMatching(/^findings-\d{4}-\d{2}-\d{2}\.csv$/),
          mimeType: "text/csv;charset=utf-8",
          content: expect.stringContaining(
            '"Confirmed IDOR","https://app.example.test","Access Control / IDOR","high","7.1","active"',
          ),
        }),
      );
    });
  });

  it("guards exported cells against spreadsheet formulas", async () => {
    mockConvexQuery.mockResolvedValue({
      page: [
        {
          ...mockFinding,
          title: '=HYPERLINK("https://evil.example","Open")',
          target: "+cmd|' /C calc'!A0",
        },
      ],
      isDone: true,
      continueCursor: "",
    });
    render(<Page />);

    fireEvent.click(
      screen.getByRole("button", { name: "Export findings as CSV" }),
    );

    await waitFor(() => {
      expect(mockDownloadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            `"'=HYPERLINK(""https://evil.example"",""Open"")","'+cmd|' /C calc'!A0"`,
          ),
        }),
      );
    });
  });

  it("drops legacy source-chat filter parameters", () => {
    mockSearchParams.set("chat", "chat-1");
    window.history.replaceState({}, "", "/findings?chat=chat-1");

    render(<Page />);

    expect(screen.queryByLabelText("Filter by source chat")).toBeNull();
    expect(window.location.search).toBe("");
    expect(mockUsePaginatedQuery).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ chatId: expect.anything() }),
      { initialNumItems: 25 },
    );
  });

  it("guides first-time users into a persistent Agent security test", () => {
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
    });

    render(<Page />);

    expect(screen.getByText("No findings yet")).toBeVisible();
    expect(
      screen.getByText(/Once it confirms a vulnerability with solid evidence/i),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Start your first scan" }),
    );

    expect(mockCloseSidebar).toHaveBeenCalled();
    expect(mockInitializeNewChat).toHaveBeenCalled();
    expect(mockSetTemporaryChatsEnabled).toHaveBeenCalledWith(false);
    expect(mockSetChatMode).toHaveBeenCalledWith("agent");
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("shows a reset action when search results are empty", async () => {
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
    });

    render(<Page />);
    fireEvent.change(screen.getByLabelText("Search findings"), {
      target: { value: "missing target" },
    });

    expect(await screen.findByText("No matching findings")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByLabelText("Search findings")).toHaveValue("");
    await waitFor(() => {
      expect(screen.getByText("No findings yet")).toBeVisible();
      expect(window.location.search).toBe("");
    });
  });

  it("opens and closes the reusable detail in a focused modal", async () => {
    render(<Page />);
    const findingRow = screen.getByRole("link", {
      name: /Confirmed IDOR/i,
    });
    expect(findingRow).toHaveAttribute("href", "/findings?finding=finding-1");
    fireEvent.click(findingRow);
    const dialog = screen.getByRole("dialog", {
      name: "Vulnerability Report",
    });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveClass("sm:max-w-6xl", "sm:rounded-2xl");
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "bg-black/60",
      "backdrop-blur-sm",
    );
    expect(screen.getByText(mockFinding.description)).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "Open source message in Invoice test",
      }),
    ).toHaveAttribute("href", "/c/chat-1#message=message-1");
    expect(mockCapture).toHaveBeenCalledWith("finding_viewed", {
      surface: "findings_page",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Close vulnerability report" }),
    );
    await waitFor(() => {
      expect(screen.queryByText(mockFinding.description)).toBeNull();
      expect(findingRow).toHaveFocus();
    });
    expect(window.location.pathname).toBe("/findings");
    expect(window.location.search).toBe("");
  });

  it("opens a finding directly from the URL", () => {
    mockSearchParams.set("finding", "finding-1");
    window.history.replaceState({}, "", "/findings?finding=finding-1");

    render(<Page />);

    expect(screen.getByText(mockFinding.description)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close vulnerability report" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Finding" })).toBeVisible();
    expect(mockCapture).toHaveBeenCalledWith("finding_viewed", {
      surface: "findings_page",
    });
  });

  it("keeps a full-screen mobile close path and restores list focus", async () => {
    render(<Page />);
    const findingRow = screen.getByRole("link", {
      name: /Confirmed IDOR/i,
    });
    findingRow.focus();
    fireEvent.click(findingRow);

    expect(
      screen.getByRole("dialog", { name: "Vulnerability Report" }),
    ).toHaveClass("h-dvh", "w-screen");
    expect(
      screen.getByRole("button", { name: "Back to Findings" }),
    ).toBeVisible();
    expect(screen.getByText(mockFinding.description)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to Findings" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Vulnerability Report" }),
      ).toBeNull();
      expect(findingRow).toHaveFocus();
    });
  });
});
