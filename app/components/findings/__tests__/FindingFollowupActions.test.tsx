import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

it("exports from More through a format dialog that shares the toolbar flow and blocks duplicates", async () => {
  let finish!: (value: { outcome: "success" }) => void;
  mockDownload.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderActions();
  const more = screen.getByRole("button", { name: "More actions" });
  await userEvent.click(more);
  await userEvent.click(screen.getByRole("menuitem", { name: "Export…" }));

  // A top-level dialog, not a nested flyout, starting on the first format.
  const dialog = screen.getByRole("dialog", { name: "Export report" });
  const formats = within(dialog).getAllByRole("button", {
    name: /^(Markdown|PDF|HTML|JSON|SARIF 2\.1)/,
  });
  expect(formats).toHaveLength(5);
  await waitFor(() => expect(formats[0]).toHaveFocus());

  await userEvent.click(formats[0]);
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload).toHaveBeenCalledWith([finding], "markdown");
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "Preparing export…",
  );
  // Rows stay focusable but inert while busy; a second pick does nothing.
  for (const format of formats)
    expect(format).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(formats[1]);
  await userEvent.keyboard("{Enter}");
  expect(mockDownload).toHaveBeenCalledTimes(1);
  // The toolbar export (hidden from assistive tech behind the modal) shares
  // the same busy state.
  expect(
    screen.getByRole("button", { name: /Exporting…/, hidden: true }),
  ).toBeDisabled();

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
  // The dialog closes when the export settles and focus returns to More.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(more).toHaveFocus());
  expect(screen.getByRole("status")).toHaveTextContent("");
});

it("closes the export dialog with Escape, returning focus to More without exporting", async () => {
  renderActions();
  const more = screen.getByRole("button", { name: "More actions" });
  await userEvent.click(more);
  await userEvent.click(screen.getByRole("menuitem", { name: "Export…" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Markdown/ })).toHaveFocus(),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(more).toHaveFocus());
  expect(mockDownload).not.toHaveBeenCalled();
});

it("offers Export in More only when the toolbar export is hidden", async () => {
  // jsdom has no layout; a non-null offsetParent stands in for a visible
  // toolbar export at wide container widths.
  const visible = jest
    .spyOn(HTMLElement.prototype, "offsetParent", "get")
    .mockReturnValue(document.body);
  try {
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      screen.getByRole("menuitem", { name: /Verify with Agent/ }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /Export/ })).toBeNull();
  } finally {
    visible.mockRestore();
  }
});

it("omits source and closure where they don't apply", async () => {
  renderActions({ showSource: false });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.queryByRole("menuitem", { name: /source/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Close finding/ })).toBeNull();
});
