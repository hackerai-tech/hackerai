import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingFollowupActions } from "../FindingFollowupActions";
import { getDraftContentById, upsertDraft } from "@/lib/utils/client-storage";
import type {
  FindingDetailRecord,
  FindingHuntState,
  FindingRetestState,
} from "@/types/finding";

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
jest.mock("@/lib/findings/client-telemetry", () => ({
  captureFindingEvent: (...args: unknown[]) => mockCaptureFinding(...args),
}));
jest.mock("@/lib/findings/export-client", () => ({
  downloadFindingsReport: (...args: unknown[]) => mockDownload(...args),
}));
const mockCaptureFinding = jest.fn();
const mockDownload = jest.fn();

const finding = {
  finding_id: "finding-1",
  chat_id: "chat-1",
  message_id: "message-1",
  chat_title: "Invoice API authz review",
  updated_at: 10,
} as FindingDetailRecord;
const retestsOn: FindingRetestState = {
  enabled: true,
  chat_title: "Invoice API authz review",
  retests: [],
};
const huntsOn: FindingHuntState = {
  enabled: true,
  chat_title: "Invoice API authz review",
  hunts: [],
};

const renderActions = (
  props: Partial<Parameters<typeof FindingFollowupActions>[0]> = {},
) =>
  render(
    <FindingFollowupActions
      finding={finding}
      surface="findings_page"
      retestState={retestsOn}
      huntState={huntsOn}
      showSource
      {...props}
    />,
  );

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

it("prepares an editable hunt draft in the source task without sending it", () => {
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Hunt similar" }));
  const draft = getDraftContentById("chat-1") ?? "";
  expect(draft).toContain("start_finding_hunt");
  expect(draft).toContain("record_finding_hunt_candidate");
  expect(draft).toContain('finding_id "finding-1"');
  expect(push).toHaveBeenCalledWith("/c/chat-1");
  expect(setChatMode).toHaveBeenCalledWith("agent");
  // Preparing a draft never sends anything.
  expect(setInput).not.toHaveBeenCalled();
});

it("never replaces an unsent draft and appends the hunt only on request", () => {
  upsertDraft("chat-1", "My existing draft");
  renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Hunt similar" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Add the hunt request below it",
  );
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(getDraftContentById("chat-1")).toBe("My existing draft");

  fireEvent.click(screen.getByRole("button", { name: "Hunt similar" }));
  fireEvent.click(screen.getByRole("button", { name: "Add below draft" }));
  expect(getDraftContentById("chat-1")).toMatch(
    /^My existing draft\n\nHunt for other surfaces/,
  );
  expect(push).toHaveBeenCalledWith("/c/chat-1");
});

it("records a retest only when retest history is enabled", () => {
  const { unmount } = renderActions();
  fireEvent.click(screen.getByRole("button", { name: "Retest" }));
  expect(getDraftContentById("chat-1")).toContain("start_finding_retest");
  unmount();
  localStorage.clear();
  renderActions({ retestState: { enabled: false } });
  fireEvent.click(screen.getByRole("button", { name: "Retest" }));
  expect(getDraftContentById("chat-1")).not.toContain("start_finding_retest");
  expect(getDraftContentById("chat-1")).toContain(
    "update_vulnerability_report",
  );
});

it("offers no action before its rollout is known and blocks a second run", () => {
  const { rerender } = renderActions({
    retestState: undefined,
    huntState: undefined,
  });
  expect(screen.getByRole("button", { name: "Retest" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /Hunt/ })).toBeNull();

  rerender(
    <FindingFollowupActions
      finding={finding}
      surface="findings_page"
      retestState={retestsOn}
      huntState={{ enabled: false }}
      showSource
    />,
  );
  expect(screen.queryByRole("button", { name: /Hunt/ })).toBeNull();

  rerender(
    <FindingFollowupActions
      finding={finding}
      surface="findings_page"
      retestState={retestsOn}
      huntState={{
        ...huntsOn,
        hunts: [
          {
            hunt_id: "h1",
            chat_id: "chat-1",
            assistant_message_id: "m1",
            status: "running",
            started_at: 1,
            candidates: [],
          },
        ],
      }}
      showSource
    />,
  );
  expect(screen.getByRole("button", { name: "Hunting…" })).toBeDisabled();
});

it("keeps verify, export, source and closure reachable in the More menu", async () => {
  const onCloseFinding = jest.fn();
  renderActions({ onCloseFinding });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(
    screen.getByRole("menuitem", { name: /Verify with Agent/ }),
  ).toBeVisible();
  expect(screen.getByRole("menuitem", { name: /Export/ })).toBeVisible();
  expect(
    screen.getByRole("menuitem", { name: /Open source message/ }),
  ).toHaveAttribute("href", "/c/chat-1#message=message-1");
  await userEvent.click(
    screen.getByRole("menuitem", { name: /Close finding/ }),
  );
  expect(onCloseFinding).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(
    screen.getByRole("menuitem", { name: /Verify with Agent/ }),
  );
  expect(getDraftContentById("chat-1")).toContain(
    "strongest alternative explanation",
  );
});

it.each(["findings_page", "computer_sidebar"] as const)(
  "attributes source navigation to the %s surface it was opened from",
  async (surface) => {
    renderActions({ surface });
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    const source = screen.getByRole("menuitem", {
      name: /Open source message/,
    });
    expect(source).toHaveAttribute("href", "/c/chat-1#message=message-1");
    fireEvent.click(source);
    expect(mockCaptureFinding).toHaveBeenCalledWith({
      operation: "source",
      outcome: "initiated",
      finding_id: "finding-1",
      surface,
    });
  },
);

it("exports from the More submenu through the shared flow and blocks duplicates while busy", async () => {
  let finish!: (value: { outcome: "success" }) => void;
  mockDownload.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderActions();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Export/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Markdown/ }));

  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload).toHaveBeenCalledWith([finding], "markdown");
  expect(screen.getByRole("status")).toHaveTextContent("Preparing export…");
  // The toolbar export shares the busy state.
  const toolbar = screen.getByRole("button", { name: /Exporting…/ });
  expect(toolbar).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getByRole("menuitem", { name: /Exporting…/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(mockDownload).toHaveBeenCalledTimes(1);

  await act(async () => finish({ outcome: "success" }));
  expect(mockCaptureFinding).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "export",
      phase: "save",
      outcome: "success",
      format: "markdown",
      finding_id: "finding-1",
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("");
});

it("omits source and closure where they don't apply", async () => {
  renderActions({ showSource: false });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.queryByRole("menuitem", { name: /source/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Close finding/ })).toBeNull();
});
