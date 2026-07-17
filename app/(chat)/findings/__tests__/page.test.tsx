import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockUsePaginatedQuery = jest.fn();
const mockUseQuery = jest.fn((_ref: unknown, args: any) =>
  args?.findingId ? mockFinding : mockSourceChats,
);
const mockCapture = jest.fn();
const mockPush = jest.fn();
const mockCloseSidebar = jest.fn();
const mockInitializeNewChat = jest.fn();
const mockSetChatMode = jest.fn();
const mockSetTemporaryChatsEnabled = jest.fn();
let mockMobile = false;

jest.mock("convex/react", () => ({
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
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockMobile,
}));

jest.mock("@/app/hooks/useTauri", () => ({ navigateToAuth: jest.fn() }));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCapture,
}));

const mockFinding = {
  finding_id: "finding-1",
  title: "Confirmed IDOR",
  target: "https://app.example.test",
  endpoint: "/api/invoices/other",
  method: "GET",
  severity: "high",
  cvss_score: 7.1,
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

const mockSourceChats = [{ chat_id: "chat-1", chat_title: "Invoice test" }];

const Page = require("../page").default as typeof import("../page").default;

describe("FindingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMobile = false;
    mockUsePaginatedQuery.mockReturnValue({
      results: [mockFinding],
      status: "Exhausted",
      loadMore: jest.fn(),
    });
  });

  it("lists metadata, searches, and exposes severity/source filters", async () => {
    render(<Page />);
    expect(screen.getByRole("heading", { name: "Findings" })).toBeVisible();
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();
    expect(screen.getByText("/api/invoices/other")).toBeVisible();
    expect(screen.getByText("Invoice test")).toBeVisible();
    expect(screen.getByText("CVSS 7.1")).toBeVisible();
    expect(screen.getByLabelText("Filter by severity")).toBeVisible();
    expect(screen.getByLabelText("Filter by source chat")).toBeVisible();

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
    expect(mockCapture).toHaveBeenCalledWith("findings_page_viewed");
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
      screen.getByRole("button", { name: "Start your first security test" }),
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
    });
  });

  it("opens the reusable detail alongside the desktop list", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("Confirmed IDOR"));
    expect(screen.getByText(mockFinding.description)).toBeVisible();
    expect(screen.getByRole("link", { name: /Invoice test/i })).toHaveAttribute(
      "href",
      "/c/chat-1",
    );
    expect(mockCapture).toHaveBeenCalledWith("finding_viewed", {
      surface: "findings_page",
    });
  });

  it("uses a full-screen mobile detail with a back control", () => {
    mockMobile = true;
    render(<Page />);
    fireEvent.click(screen.getByText("Confirmed IDOR"));
    expect(
      screen.getByRole("button", { name: "Back to findings" }),
    ).toBeVisible();
    expect(screen.getByText(mockFinding.description)).toBeVisible();
  });
});
