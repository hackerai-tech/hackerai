import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CaptchaSolverActivity } from "../CaptchaSolverActivity";
import { computeShellTerminalBlock } from "../shell-tool-utils";
import { getCaptchaStartedAt } from "../captcha-tool-utils";

const command = "hackerai-captcha solve --session synthetic_session";
afterEach(() => jest.useRealTimers());

it("shows real elapsed time while solving and freezes the recorded duration on delivery", () => {
  jest.useFakeTimers();
  jest.setSystemTime(100_000);
  const view = render(
    <CaptchaSolverActivity
      command={command}
      activity={{ state: "solving", startedAt: 75_000 }}
    />,
  );
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByText("0:26 elapsed")).toBeVisible();
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByText("0:27 elapsed")).toBeVisible();
  view.rerender(
    <CaptchaSolverActivity
      command={command}
      activity={{
        state: "response_delivered",
        startedAt: 75_000,
        elapsedMs: 27_000,
      }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Response delivered");
  expect(
    screen.getByText(/Website acceptance is checked separately/),
  ).toBeVisible();
  act(() => jest.advanceTimersByTime(10_000));
  expect(screen.getByText("0:27 elapsed")).toBeVisible();
  expect(screen.getByText(command)).not.toBeVisible();
  fireEvent.click(screen.getByText("Command details"));
  expect(screen.getByText(command)).toBeVisible();
});

it("uses only this tool's start event and never presents a verification failure as success", () => {
  const startedAt = getCaptchaStartedAt(
    [
      {
        type: "data-terminal",
        data: { toolCallId: "other", captchaStartedAt: 10 },
      },
      {
        type: "data-terminal",
        data: { toolCallId: "owned", captchaStartedAt: 25 },
      },
    ],
    "owned",
  );
  expect(startedAt).toBe(25);
  const block = computeShellTerminalBlock({
    isShellTool: false,
    shellInput: undefined,
    legacyCommand: command,
    toolCallId: "owned",
    isExecuting: false,
    hasResult: true,
    shellOutput: {
      result: {
        exitCode: 0,
        browserChallenge: {
          status: "handoff_required",
          reason: "response_not_retained",
        },
        callTiming: { elapsedMs: 10_000 },
      },
    },
  });
  expect(block.sidebarContent?.captcha?.state).toBe("needs_verification");
  render(
    <CaptchaSolverActivity
      command={command}
      activity={block.sidebarContent!.captcha!}
      compact
    />,
  );
  expect(screen.getByText("Needs verification")).toBeVisible();
  expect(screen.queryByText(/solved|success/i)).not.toBeInTheDocument();
});

it("stops the live indicator when a run ends without a tool result", () => {
  const block = computeShellTerminalBlock({
    isShellTool: false,
    shellInput: undefined,
    legacyCommand: command,
    toolCallId: "owned",
    isExecuting: true,
    isRunActive: false,
    hasResult: false,
    executionPhase: "executing",
    captchaStartedAt: 1000,
  });
  expect(block.sidebarContent?.captcha?.state).toBe("stopped");
});
