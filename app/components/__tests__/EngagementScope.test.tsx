import { ConvexError } from "convex/values";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EngagementScope } from "../EngagementScope";
import type { ScopeSnapshot } from "@/lib/engagement-scope/policy";
let mockScope: ScopeSnapshot | null;
const mockSave = jest.fn();
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => mockScope,
  useMutation: () => mockSave,
}));
beforeEach(() => {
  mockSave.mockReset().mockResolvedValue(3);
  mockScope = {
    rules: [
      { target: "example.test", effect: "allow", activity: "active_testing" },
    ],
    restrictions: [],
    revision: 2,
    status: "ready",
    clarification: "",
    clarificationRequested: false,
  };
});
it("shows saved scope without a setup wizard and saves an explicit edit against the opened revision", async () => {
  const { rerender } = render(<EngagementScope chatId="chat" />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "View and edit engagement scope" }),
  );
  expect(screen.getByLabelText("Targets and exclusions")).toHaveValue(
    "allow example.test",
  );
  fireEvent.change(screen.getByLabelText("Targets and exclusions"), {
    target: { value: "allow *.example.test\nno-contact admin.example.test" },
  });
  mockScope = { ...mockScope!, revision: 4 };
  rerender(<EngagementScope chatId="chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Save scope" }));
  await waitFor(() =>
    expect(mockSave).toHaveBeenCalledWith({
      chatId: "chat",
      expectedRevision: 2,
      policy: {
        rules: [
          {
            target: "*.example.test",
            effect: "allow",
            activity: "active_testing",
          },
          {
            target: "admin.example.test",
            effect: "deny",
            activity: "all_contact",
          },
        ],
        restrictions: [],
      },
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
it("keeps edits visible on a conflict and never silently saves invalid scope", async () => {
  render(<EngagementScope chatId="chat" />);
  fireEvent.click(
    screen.getByRole("button", { name: "View and edit engagement scope" }),
  );
  fireEvent.change(screen.getByLabelText("Targets and exclusions"), {
    target: { value: "allow https://example.test/?secret=1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save scope" }));
  await screen.findByRole("alert");
  expect(mockSave).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Targets and exclusions"), {
    target: { value: "allow example.test" },
  });
  mockSave.mockRejectedValue(
    new ConvexError("Scope changed. Reopen it before saving."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save scope" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Scope changed"),
  );
  expect(screen.getByLabelText("Targets and exclusions")).toHaveValue(
    "allow example.test",
  );
});
it("does not add scope UI to a chat without an engagement", () => {
  mockScope = null;
  render(<EngagementScope chatId="chat" />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
