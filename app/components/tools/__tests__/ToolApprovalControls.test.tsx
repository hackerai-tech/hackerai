import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";

let resolveApprovalInput: (() => void) | undefined;
const mockSendAgentApprovalSessionInput = jest.fn(
  () =>
    new Promise<void>((resolve) => {
      resolveApprovalInput = resolve;
    }),
);
const approvalPrefixRule = ["ping", "-c", "4"];

jest.mock("@/lib/chat/agent-approval-session", () => ({
  sendAgentApprovalSessionInput: () => mockSendAgentApprovalSessionInput(),
}));

import {
  AgentApprovalProvider,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";
import {
  getStreamedAgentAutoReviewLifecycle,
  getStreamedAgentAutoReviewSummary,
  getAgentAutoReviewDisplayState,
  getToolApprovalDisplayState,
  getToolApprovalDisplayTarget,
  ToolApprovalControls,
  useAgentAutoReviewLifecycleDisplay,
} from "../ToolApprovalControls";

const autoReview = {
  verdict: "ask_user" as const,
  riskCategory: "destructive" as const,
  rationale: "This action deletes filesystem data, so the user must decide.",
  rolloutPhase: "enforce" as const,
};

function ApprovalStatusHarness() {
  const {
    activeToolApprovalRequest,
    setAgentApprovalSession,
    sendToolApproval,
  } = useAgentApproval();
  const [showApprovalControls, setShowApprovalControls] = useState(true);

  useEffect(() => {
    setAgentApprovalSession({
      chatId: "chat-1",
      sessionId: "session-1",
      publicAccessToken: "token-1",
    });
  }, [setAgentApprovalSession]);

  return (
    <>
      {showApprovalControls ? (
        <ToolApprovalControls
          approvalId="approval-1"
          toolCallId="tool-1"
          title="Allow HackerAI to run this terminal command?"
          target="ping -c 4 hackerone.com"
          justification="Check whether the target host is reachable."
          prefixRule={approvalPrefixRule}
          kind="terminal"
          operation="terminal_execute"
          autoReview={autoReview}
        >
          {(sendState) => (
            <span data-testid="approval-row-state">{sendState}</span>
          )}
        </ToolApprovalControls>
      ) : null}
      <span data-testid="active-approval-request">
        {JSON.stringify(activeToolApprovalRequest)}
      </span>
      <button
        type="button"
        onClick={() =>
          void sendToolApproval({
            approvalId: "approval-1",
            toolCallId: "tool-1",
            decision: "approve",
          })
        }
      >
        Approve
      </button>
      <button type="button" onClick={() => setShowApprovalControls(false)}>
        Replace tool row
      </button>
    </>
  );
}

describe("ToolApprovalControls", () => {
  beforeEach(() => {
    resolveApprovalInput = undefined;
    mockSendAgentApprovalSessionInput.mockClear();
  });

  it("shows approval sending until the server accepts the input", async () => {
    render(
      <AgentApprovalProvider>
        <ApprovalStatusHarness />
      </AgentApprovalProvider>,
    );

    expect(screen.getByTestId("approval-row-state")).toHaveTextContent("idle");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByTestId("approval-row-state")).toHaveTextContent(
        "sending",
      ),
    );

    await act(async () => {
      resolveApprovalInput?.();
    });

    await waitFor(() =>
      expect(screen.getByTestId("approval-row-state")).toHaveTextContent(
        "approved",
      ),
    );
    expect(screen.getByTestId("active-approval-request")).toHaveTextContent(
      '"approvalId":"approval-1"',
    );
  });

  it("forwards live approval metadata to the ChatInput prompt", async () => {
    render(
      <AgentApprovalProvider>
        <ApprovalStatusHarness />
      </AgentApprovalProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("active-approval-request")).toHaveTextContent(
        JSON.stringify({
          approvalId: "approval-1",
          toolCallId: "tool-1",
          title: "Allow HackerAI to run this terminal command?",
          target: "ping -c 4 hackerone.com",
          justification: "Check whether the target host is reachable.",
          prefixRule: ["ping", "-c", "4"],
          kind: "terminal",
          operation: "terminal_execute",
          autoReview,
        }),
      ),
    );
  });

  it("reads only the typed Auto review summary for the exact approval", () => {
    const matchingPart = {
      type: "data-agent-auto-review",
      data: {
        approvalId: "approval-1",
        toolCallId: "tool-1",
        autoReview,
      },
    };

    expect(
      getStreamedAgentAutoReviewSummary({
        parts: [matchingPart],
        approvalId: "approval-1",
        toolCallId: "tool-1",
      }),
    ).toEqual(autoReview);
    expect(
      getStreamedAgentAutoReviewSummary({
        parts: [matchingPart],
        approvalId: "approval-2",
        toolCallId: "tool-1",
      }),
    ).toBeUndefined();
    expect(
      getStreamedAgentAutoReviewSummary({
        parts: [
          {
            ...matchingPart,
            data: { ...matchingPart.data, autoReview: { verdict: "approve" } },
          },
        ],
        approvalId: "approval-1",
        toolCallId: "tool-1",
      }),
    ).toBeUndefined();
  });

  it("reads the latest typed Auto review lifecycle for the exact tool", () => {
    const startedAt = Date.now();
    const reviewing = {
      type: "data-agent-auto-review-lifecycle",
      data: {
        approvalId: "approval-1",
        toolCallId: "tool-1",
        status: "reviewing",
        startedAt,
      },
    };
    const approved = {
      type: "data-agent-auto-review-lifecycle",
      data: {
        ...reviewing.data,
        status: "approved",
        completedAt: startedAt + 700,
      },
    };

    expect(
      getStreamedAgentAutoReviewLifecycle({
        parts: [reviewing, approved],
        toolCallId: "tool-1",
      }),
    ).toEqual(approved.data);
    expect(
      getStreamedAgentAutoReviewLifecycle({
        parts: [reviewing, approved],
        toolCallId: "tool-2",
      }),
    ).toBeUndefined();
    expect(
      getStreamedAgentAutoReviewLifecycle({
        parts: [{ ...approved, data: { status: "approved" } }],
        toolCallId: "tool-1",
      }),
    ).toBeUndefined();
  });

  it("avoids flicker for fast automatic reviews", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    const startedAt = Date.now();
    const reviewing = {
      type: "data-agent-auto-review-lifecycle",
      data: {
        approvalId: "approval-1",
        toolCallId: "tool-1",
        status: "reviewing",
        startedAt,
      },
    };
    const { result, rerender } = renderHook(
      ({ parts }) =>
        useAgentAutoReviewLifecycleDisplay({ parts, toolCallId: "tool-1" }),
      { initialProps: { parts: [reviewing] } },
    );

    act(() => jest.advanceTimersByTime(200));
    expect(result.current).toBeUndefined();

    rerender({
      parts: [
        reviewing,
        {
          type: "data-agent-auto-review-lifecycle",
          data: {
            ...reviewing.data,
            status: "approved",
            completedAt: Date.now(),
          },
        },
      ],
    });
    act(() => jest.runOnlyPendingTimers());
    expect(result.current).toBeUndefined();
    jest.useRealTimers();
  });

  it("shows delayed review progress and removes it after automatic approval", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    const startedAt = Date.now();
    const reviewing = {
      type: "data-agent-auto-review-lifecycle",
      data: {
        approvalId: "approval-1",
        toolCallId: "tool-1",
        status: "reviewing",
        startedAt,
      },
    };
    const { result, rerender } = renderHook(
      ({ parts }) =>
        useAgentAutoReviewLifecycleDisplay({ parts, toolCallId: "tool-1" }),
      { initialProps: { parts: [reviewing] } },
    );

    act(() => jest.advanceTimersByTime(450));
    expect(result.current).toBe("reviewing");

    rerender({
      parts: [
        reviewing,
        {
          type: "data-agent-auto-review-lifecycle",
          data: {
            ...reviewing.data,
            status: "approved",
            completedAt: Date.now(),
          },
        },
      ],
    });
    act(() => jest.advanceTimersByTime(0));
    expect(result.current).toBeUndefined();
    jest.useRealTimers();
  });

  it("keeps a settled prompt mounted when its tool row is replaced", async () => {
    jest.useFakeTimers();

    render(
      <AgentApprovalProvider>
        <ApprovalStatusHarness />
      </AgentApprovalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await act(async () => resolveApprovalInput?.());
    await act(async () => {});

    expect(screen.getByTestId("approval-row-state")).toHaveTextContent(
      "approved",
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace tool row" }));

    expect(screen.getByTestId("active-approval-request")).toHaveTextContent(
      '"approvalId":"approval-1"',
    );

    act(() => jest.runOnlyPendingTimers());

    expect(screen.getByTestId("active-approval-request")).toHaveTextContent(
      "null",
    );
    jest.useRealTimers();
  });

  it("maps approval send states to immediate tool-row labels", () => {
    expect(
      getToolApprovalDisplayState({
        sendState: "idle",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Awaiting approval", isShimmer: false });
    expect(
      getToolApprovalDisplayState({
        sendState: "sending",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Approving", isShimmer: true });
    expect(
      getToolApprovalDisplayState({
        sendState: "approved",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Executing", isShimmer: true });
    expect(
      getToolApprovalDisplayState({
        sendState: "denied",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Command denied", isShimmer: false });
  });

  it("keeps lifecycle labels lightweight and free of additional motion", () => {
    expect(getAgentAutoReviewDisplayState("reviewing")).toEqual({
      action: "Reviewing",
      isShimmer: false,
    });
    expect(getAgentAutoReviewDisplayState("approved")).toBeUndefined();
    expect(getAgentAutoReviewDisplayState("needs_approval")).toEqual({
      action: "Needs your approval",
      isShimmer: false,
    });
  });

  it("keeps the exact target visible throughout approval", () => {
    for (const sendState of [
      "idle",
      "sending",
      "approved",
      "denied",
    ] as const) {
      expect(
        getToolApprovalDisplayTarget({ sendState, target: "rm -rf /tmp/test" }),
      ).toBe("rm -rf /tmp/test");
    }
  });
});
