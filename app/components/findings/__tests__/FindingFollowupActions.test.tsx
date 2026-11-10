import { fireEvent, render, screen } from "@testing-library/react";
import { FindingFollowupActions } from "../FindingFollowupActions";
import { getDraftContentById, upsertDraft } from "@/lib/utils/client-storage";
import type { FindingDetailRecord } from "@/types/finding";
const push = jest.fn();
const setInput = jest.fn();
const getInput = jest.fn(() => "");
const setChatMode = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/findings",
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ closeSidebar: jest.fn(), setChatMode }),
}));
jest.mock("@/app/contexts/ComposerState", () => ({
  useComposerActions: () => ({ getInput, setInput }),
}));
const finding = {
  finding_id: "finding-1",
  chat_id: "chat-1",
  updated_at: 10,
} as FindingDetailRecord;
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});
it("prepares an editable scoped request without submitting or replacing an existing draft", () => {
  upsertDraft("chat-1", "My existing draft");
  render(<FindingFollowupActions finding={finding} />);
  fireEvent.click(screen.getByRole("button", { name: "Verify", exact: true }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(push).not.toHaveBeenCalled();
  expect(getDraftContentById("chat-1")).toBe("My existing draft");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(getDraftContentById("chat-1")).toBe("My existing draft");
  fireEvent.click(screen.getByRole("button", { name: "Retest", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Add below draft" }));
  expect(getDraftContentById("chat-1")).toMatch(/^My existing draft\n\nRetest/);
  expect(push).toHaveBeenCalledWith("/c/chat-1");
  expect(setChatMode).toHaveBeenCalledWith("agent");
});
it("prepares verification in the original source chat", () => {
  render(<FindingFollowupActions finding={finding} />);
  fireEvent.click(screen.getByRole("button", { name: "Verify", exact: true }));
  expect(getDraftContentById("chat-1")).toContain('finding_id "finding-1"');
  expect(push).toHaveBeenCalledWith("/c/chat-1");
});
