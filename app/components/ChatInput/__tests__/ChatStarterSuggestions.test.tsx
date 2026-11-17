import "@testing-library/jest-dom";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { upsertDraft } from "@/lib/utils/client-storage";
import { setAuthenticatedAnalyticsUserId } from "@/lib/analytics/client";
import type { UploadedFileState } from "@/types/file";
import type { ChatMode } from "@/types/chat";

const mockCapture =
  jest.fn<(event: string, properties: Record<string, unknown>) => boolean>();
type QueuedEvent = {
  event: string;
  properties?: Record<string, unknown>;
  dedupeKey: string;
};
const mockQueuedCapture = jest.fn<(event: QueuedEvent) => boolean>();
jest.mock("@/lib/analytics/client", () => ({
  ...jest.requireActual<typeof import("@/lib/analytics/client")>(
    "@/lib/analytics/client",
  ),
  captureAuthenticatedEvent: (
    event: string,
    properties: Record<string, unknown>,
  ) => mockCapture(event, properties),
  captureQueuedAuthenticatedEvent: (event: QueuedEvent) =>
    mockQueuedCapture(event),
}));
const selectedEvents = () =>
  mockQueuedCapture.mock.calls
    .map(([queued]) => queued)
    .filter(({ event }) => event === "chat_starter_selected");

let mockIsMobile = false;
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

let mockChatMode: ChatMode = "agent";
const mockSetChatMode = jest.fn();
jest.mock("@/app/contexts/GlobalState", () => {
  const original = jest.requireActual<
    typeof import("@/app/contexts/GlobalState")
  >("@/app/contexts/GlobalState");
  return {
    ...original,
    useGlobalState: () => ({
      ...original.useGlobalState(),
      chatMode: mockChatMode,
      setChatMode: mockSetChatMode,
      chatModeAccessResolved: true,
      isCheckingProPlan: false,
      subscription: "pro",
    }),
  };
});

jest.mock("react-hotkeys-hook", () => ({ useHotkeys: jest.fn() }));
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useMutation: () => jest.fn(),
  useAction: () => jest.fn(),
  useQuery: () => undefined,
}));
jest.mock("@/app/hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    fileInputRef: { current: null },
    handleFileUploadEvent: jest.fn(),
    handleRemoveFile: jest.fn(),
    handleRetryFile: jest.fn(),
    handleUpdateGeneratedTextFile: jest.fn(),
    handleAttachClick: jest.fn(),
    handlePasteEvent: jest.fn(),
    handlePastedTextAttachment: jest.fn(),
  }),
}));
jest.mock("@/app/hooks/useTauri", () => ({
  useTauri: () => ({ isTauri: false }),
  isTauriEnvironment: () => false,
  readGeneratedTextAttachment: jest.fn(),
}));

const { ChatInput } =
  jest.requireActual<typeof import("../ChatInput")>("../ChatInput");
const { GlobalStateProvider, useGlobalState } = jest.requireActual<
  typeof import("@/app/contexts/GlobalState")
>("@/app/contexts/GlobalState");
const { AgentApprovalProvider } = jest.requireActual<
  typeof import("@/app/contexts/AgentApprovalContext")
>("@/app/contexts/AgentApprovalContext");
const { AgentAutoReviewAvailabilityProvider } = jest.requireActual<
  typeof import("@/app/contexts/AgentAutoReviewAvailabilityContext")
>("@/app/contexts/AgentAutoReviewAvailabilityContext");
const { ChatStartersProvider } = jest.requireActual<
  typeof import("@/app/contexts/ChatStartersContext")
>("@/app/contexts/ChatStartersContext");
const { useComposerActions } = jest.requireActual<
  typeof import("@/app/contexts/ComposerState")
>("@/app/contexts/ComposerState");

const TEST_A_TARGET_PROMPT =
  "Test [URL or IP] within [scope]. Start with recon, dig into promising leads, and report what you verified with evidence and useful next steps; ask only if scope details are missing.";

type History = {
  chats: { status: string; results: unknown[] };
  projects: { results: unknown[] };
};
const NO_HISTORY: History = {
  chats: { status: "Exhausted", results: [] },
  projects: { results: [] },
};
const RETURNING: History = {
  chats: { status: "Exhausted", results: [{ _id: "chat" }] },
  projects: { results: [] },
};

let composer: ReturnType<typeof useComposerActions>;
let setFiles: (files: UploadedFileState[]) => void;
const Probes = () => {
  const actions = useComposerActions();
  const { setUploadedFiles } = useGlobalState();
  // Publish after commit; tests call these from outside React.
  useEffect(() => {
    composer = actions;
    setFiles = setUploadedFiles;
  }, [actions, setUploadedFiles]);
  return null;
};

const mockFetch = jest.fn<typeof fetch>();
let starterFlag = true;

const renderStarters = ({
  history = NO_HISTORY,
  onSubmit = jest.fn<() => boolean | void>(() => true),
  props = {},
}: {
  history?: History;
  onSubmit?: jest.Mock<() => boolean | void>;
  props?: Partial<Parameters<typeof ChatInput>[0]>;
} = {}) => {
  const ui = (
    <GlobalStateProvider>
      <AgentAutoReviewAvailabilityProvider>
        <AgentApprovalProvider>
          <TooltipProvider>
            <ChatStartersProvider userId="user-1" {...history}>
              <Probes />
              <ChatInput
                onSubmit={onSubmit}
                onStop={jest.fn()}
                onSendNow={jest.fn()}
                status="ready"
                isNewChat
                isCentered={!mockIsMobile}
                chatId="new-chat-id"
                {...props}
              />
            </ChatStartersProvider>
          </TooltipProvider>
        </AgentApprovalProvider>
      </AgentAutoReviewAvailabilityProvider>
    </GlobalStateProvider>
  );
  return { ...render(ui), onSubmit };
};

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const flushFrames = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
const openMenu = (name: string) =>
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
const menuLabels = () =>
  screen
    .getAllByRole("menuitem")
    .map((item) => item.firstElementChild?.textContent);
const insertLabels = () =>
  screen
    .getAllByRole("button", { name: /^Insert example:/ })
    .map((button) => button.textContent);

describe("Chat starter suggestions in the composer", () => {
  beforeEach(() => {
    mockIsMobile = false;
    mockChatMode = "agent";
    starterFlag = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
    // Selections are recorded only while consent permits the signed-in user.
    setAuthenticatedAnalyticsUserId("user-1");
    mockCapture.mockReset().mockReturnValue(true);
    mockQueuedCapture.mockReset().mockReturnValue(true);
    jest.mocked(useAuth).mockReturnValue({
      user: { id: "user-1", firstName: "Alex" },
      entitlements: [],
    } as unknown as ReturnType<typeof useAuth>);
    mockFetch.mockReset().mockImplementation(async (url) =>
      String(url).includes("/api/chat-starters")
        ? ({
            ok: true,
            json: async () => ({ enabled: starterFlag }),
          } as Response)
        : ({ ok: true, json: async () => ({ enabled: false }) } as Response),
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: mockFetch,
    });
  });

  afterEach(() => {
    // Reset consent while the mounted composer can still read its user.
    act(() => setAuthenticatedAnalyticsUserId(null));
    jest.mocked(useAuth).mockReset();
  });

  it("fills and focuses the composer without sending or changing mode", async () => {
    const { onSubmit } = renderStarters();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Insert example: Test a target",
      }),
    );
    await flushFrames();

    expect(textarea()).toHaveValue(TEST_A_TARGET_PROMPT);
    expect(textarea()).toHaveFocus();
    expect(textarea().selectionStart).toBe(TEST_A_TARGET_PROMPT.length);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(mockSetChatMode).not.toHaveBeenCalled();
    // The filled composer replaces the suggestions.
    expect(screen.queryByTestId("chat-starters")).not.toBeInTheDocument();
    expect(selectedEvents()).toEqual([
      {
        event: "chat_starter_selected",
        properties: {
          selection_id: expect.any(String),
          definition_version: 2,
          example_id: "test_target",
          mode: "agent",
          presentation: "expanded",
        },
        dedupeKey: expect.any(String),
      },
    ]);
    // The selection ID is the event's stable dedupe key.
    expect(selectedEvents()[0].dedupeKey).toBe(
      selectedEvents()[0].properties?.selection_id,
    );
    expect(JSON.stringify(mockQueuedCapture.mock.calls)).not.toContain(
      "[scope]",
    );
  });

  it("queues every accepted selection while analytics is not ready yet", async () => {
    // The immediate SDK path is unavailable; selections must still be queued.
    mockCapture.mockReturnValue(false);
    renderStarters();

    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Insert example: Fix a tool error",
        }),
      );
      await flushFrames();
      expect(textarea().value).toMatch(/^Help me fix this \[tool\] error/);
      expect(textarea()).toHaveFocus();
      fireEvent.change(textarea(), { target: { value: "" } });
    }

    const [first, second] = selectedEvents();
    expect(selectedEvents()).toHaveLength(2);
    expect(first.properties).toEqual({
      selection_id: expect.any(String),
      definition_version: 2,
      example_id: "fix_tool_error",
      mode: "agent",
      presentation: "expanded",
    });
    // Repeat selections are distinct events, not deduplicated retries.
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    expect(first.properties?.selection_id).not.toBe(
      second.properties?.selection_id,
    );
    expect(JSON.stringify(selectedEvents())).not.toContain("[tool]");
  });

  it("records an exposure only after the suggestions render", async () => {
    renderStarters();
    await screen.findByTestId("chat-starters");
    await flushFrames();

    expect(mockCapture).toHaveBeenCalledWith("chat_starters_exposed", {
      definition_version: 2,
      mode: "agent",
      presentation: "expanded",
    });
  });

  it("retries a lost exposure when analytics becomes ready while visible", async () => {
    let analyticsReady = false;
    mockCapture.mockImplementation(
      (event) => event !== "chat_starters_exposed" || analyticsReady,
    );
    const exposureAttempts = () =>
      mockCapture.mock.calls.filter(
        ([event]) => event === "chat_starters_exposed",
      ).length;
    // The real readiness subscription notifies whenever the analytics user changes.
    const notifyAnalyticsReadiness = async (userId: string | null) => {
      act(() => setAuthenticatedAnalyticsUserId(userId));
      await flushFrames();
    };

    // Start before analytics has resolved an owner.
    setAuthenticatedAnalyticsUserId(null);
    try {
      renderStarters();
      await screen.findByTestId("chat-starters");
      await flushFrames();
      expect(exposureAttempts()).toBe(1);

      // Hidden suggestions do not record a late exposure.
      fireEvent.change(textarea(), { target: { value: " " } });
      expect(screen.queryByTestId("chat-starters")).not.toBeInTheDocument();
      await notifyAnalyticsReadiness("user-1");
      expect(exposureAttempts()).toBe(1);

      fireEvent.change(textarea(), { target: { value: "" } });
      await flushFrames();
      expect(exposureAttempts()).toBe(2);

      analyticsReady = true;
      await notifyAnalyticsReadiness(null);
      expect(exposureAttempts()).toBe(3);
      expect(mockCapture).toHaveBeenLastCalledWith("chat_starters_exposed", {
        definition_version: 2,
        mode: "agent",
        presentation: "expanded",
      });

      await notifyAnalyticsReadiness("user-1");
      expect(exposureAttempts()).toBe(3);
    } finally {
      act(() => setAuthenticatedAnalyticsUserId(null));
    }
  });

  it("never overwrites text typed after the suggestions rendered", async () => {
    renderStarters();
    const chip = await screen.findByRole("button", {
      name: "Insert example: Fix a tool error",
    });

    // The click handler still belongs to the empty-composer render.
    act(() => {
      composer.setInput("my own request");
      fireEvent.click(chip);
    });
    await flushFrames();

    expect(textarea()).toHaveValue("my own request");
    expect(selectedEvents()).toEqual([]);
  });

  it("never overwrites a saved draft for the same new chat", async () => {
    renderStarters();
    const chip = await screen.findByRole("button", {
      name: "Insert example: Test a target",
    });
    upsertDraft("new", "draft from another tab");

    fireEvent.click(chip);
    await flushFrames();

    expect(textarea()).toHaveValue("");
  });

  it("hides while the composer has whitespace or an attachment and returns when cleared", async () => {
    renderStarters();
    await screen.findByTestId("chat-starters");

    fireEvent.change(textarea(), { target: { value: " " } });
    expect(screen.queryByTestId("chat-starters")).not.toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: "" } });
    expect(screen.getByTestId("chat-starters")).toBeInTheDocument();

    act(() =>
      setFiles([
        {
          file: { name: "scan.txt", type: "text/plain", size: 4 },
          uploading: true,
          uploaded: false,
        } as UploadedFileState,
      ]),
    );
    expect(screen.queryByTestId("chat-starters")).not.toBeInTheDocument();
    // The composer itself stays mounted with its state.
    expect(textarea()).toBeInTheDocument();
  });

  it.each([
    [{ status: "submitted" as const }],
    [{ status: "error" as const }],
    [{ isNewChat: false }],
    [{ hasMessages: true }],
    [{ sendDisabledReason: "Reconnect the selected local sandbox" }],
    [
      {
        rateLimitWarning: {
          warningType: "sliding-window" as const,
          remaining: 1,
          resetTime: new Date(),
          mode: "agent" as const,
          subscription: "pro" as const,
        },
        onDismissRateLimitWarning: jest.fn(),
      },
    ],
    [{ hasActiveGoalRun: true }],
  ])("does not show for an ineligible composer: %p", async (props) => {
    renderStarters({ props });
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/chat-starters",
        expect.anything(),
      ),
    );
    await act(async () => {});

    expect(screen.queryByTestId("chat-starters")).not.toBeInTheDocument();
    expect(textarea()).toBeInTheDocument();
  });

  it("does not show when the flag is off", async () => {
    starterFlag = false;
    renderStarters();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await act(async () => {});

    expect(screen.queryByTestId("chat-starters")).not.toBeInTheDocument();
  });

  it("shows every Agent example on desktop without a More menu", async () => {
    const { onSubmit } = renderStarters();
    await screen.findByTestId("chat-starters");

    expect(insertLabels()).toEqual([
      "Test a target",
      "Fix a tool error",
      "Plan a test",
      "Explain results",
      "Write up findings",
    ]);
    expect(
      screen.queryByRole("button", { name: "More examples" }),
    ).not.toBeInTheDocument();

    // An example that used to sit behind the menu inserts like the others.
    fireEvent.click(
      screen.getByRole("button", { name: "Insert example: Write up findings" }),
    );
    await flushFrames();
    expect(textarea().value).toMatch(
      /^Turn these test notes into a clear report/,
    );
    expect(textarea()).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(selectedEvents().map(({ properties }) => properties)).toEqual([
      {
        selection_id: expect.any(String),
        definition_version: 2,
        example_id: "write_up_findings",
        mode: "agent",
        presentation: "expanded",
      },
    ]);
  });

  it("keeps live checks out of Ask while showing its other examples", async () => {
    mockChatMode = "ask";
    renderStarters();
    await screen.findByTestId("chat-starters");

    expect(insertLabels()).toEqual([
      "Fix a tool error",
      "Plan a test",
      "Explain results",
      "Write up findings",
    ]);
    expect(
      screen.queryByRole("button", { name: "More examples" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Insert example: Explain results" }),
    );
    await flushFrames();
    expect(textarea().value).toMatch(/^Explain these \[tool\] results/);
    expect(textarea()).toHaveFocus();
    expect(selectedEvents().map(({ properties }) => properties)).toEqual([
      {
        selection_id: expect.any(String),
        definition_version: 2,
        example_id: "explain_results",
        mode: "ask",
        presentation: "expanded",
      },
    ]);
  });

  it("shows only a collapsed Examples menu to returning users", async () => {
    renderStarters({ history: RETURNING });
    const examples = await screen.findByRole("button", { name: "Examples" });

    expect(
      screen.queryByRole("button", { name: /^Insert example:/ }),
    ).not.toBeInTheDocument();
    openMenu("Examples");
    within(screen.getByRole("menu")).getByRole("menuitem", {
      name: /Test a target/,
    });
    expect(examples).toBeInTheDocument();
  });

  it("collapses after the first accepted submission but not a refused one", async () => {
    const onSubmit = jest.fn<() => boolean | void>().mockReturnValueOnce(false);
    renderStarters({ onSubmit });
    await screen.findByRole("button", {
      name: "Insert example: Test a target",
    });

    fireEvent.change(textarea(), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: "Enter" });
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.change(textarea(), { target: { value: "" } });
    expect(
      screen.getByRole("button", { name: "Insert example: Test a target" }),
    ).toBeInTheDocument();

    fireEvent.change(textarea(), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: "Enter" });
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    fireEvent.change(textarea(), { target: { value: "" } });
    expect(
      await screen.findByRole("button", { name: "Examples" }),
    ).toBeInTheDocument();
  });

  it("attributes the sent starter message to its selection and leaves typed sends unchanged", async () => {
    type Attribution = {
      userMessageId: string;
      onUserMessageSent?: (sent: {
        chatId: string;
        userMessageId: string;
      }) => void;
    };
    const onSubmit = jest.fn(
      (
        _event: unknown,
        _override?: string,
        _structured?: boolean,
        attribution?: Attribution,
      ) => {
        // The chat handler reports the transport handoff for this exact ID.
        attribution?.onUserMessageSent?.({
          chatId: "new-chat-id",
          userMessageId: attribution.userMessageId,
        });
        return true;
      },
    );
    try {
      renderStarters({
        onSubmit: onSubmit as unknown as jest.Mock<() => boolean | void>,
      });
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Insert example: Explain results",
        }),
      );
      await flushFrames();
      await act(async () => {
        fireEvent.keyDown(textarea(), { key: "Enter" });
      });
      const attribution = onSubmit.mock.calls[0][3];

      // The next, typed submission is not attributed to the finished selection
      // and keeps the existing two-argument call.
      fireEvent.change(textarea(), { target: { value: "my own request" } });
      await act(async () => {
        fireEvent.keyDown(textarea(), { key: "Enter" });
      });
      expect(onSubmit).toHaveBeenCalledTimes(2);
      expect(onSubmit.mock.calls[1]).toHaveLength(2);

      expect(attribution?.userMessageId).toEqual(expect.any(String));
      const submitted = mockQueuedCapture.mock.calls
        .map(([queued]) => queued)
        .filter(({ event }) => event === "chat_starter_submitted");
      expect(submitted).toEqual([
        expect.objectContaining({
          properties: expect.objectContaining({
            selection_id: selectedEvents()[0].properties?.selection_id,
            chat_id: "new-chat-id",
            user_message_id: attribution?.userMessageId,
            edited: false,
          }),
        }),
      ]);
      expect(JSON.stringify(mockQueuedCapture.mock.calls)).not.toMatch(
        /\[tool\]|my own request/,
      );
    } finally {
      window.sessionStorage.clear();
    }
  });

  it("uses tappable plain rows above the composer on mobile", async () => {
    mockIsMobile = true;
    const { onSubmit } = renderStarters();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Insert example: Fix a tool error",
      }),
    );
    await flushFrames();

    expect(textarea().value).toMatch(/^Help me fix this \[tool\] error/);
    expect(textarea()).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("opens the full example menu from the mobile More examples row", async () => {
    mockIsMobile = true;
    renderStarters();
    await screen.findByTestId("chat-starters");

    openMenu("More examples");
    expect(menuLabels()).toEqual([
      "Test a target",
      "Fix a tool error",
      "Plan a test",
      "Explain results",
      "Write up findings",
    ]);
  });
});
