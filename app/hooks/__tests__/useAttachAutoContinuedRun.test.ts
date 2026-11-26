import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import type { ChatStatus } from "@/types";
import {
  AUTO_CONTINUE_ATTACH_ATTEMPTS,
  useAttachAutoContinuedRun,
} from "../useAttachAutoContinuedRun";

type Props = {
  continuedRunId?: string;
  activeTriggerRunId?: string;
  status: ChatStatus;
};

function attach(initial: Props) {
  const resumeStream = jest.fn(async () => undefined);
  const view = renderHook(
    ({ continuedRunId, activeTriggerRunId, status }: Props) =>
      useAttachAutoContinuedRun({
        continuedRunId,
        activeTriggerRunId,
        attachedRunId: null,
        status,
        resumeStream,
      }),
    { initialProps: initial },
  );
  const settle = () => act(() => jest.runOnlyPendingTimers());
  return { resumeStream, view, settle };
}

const run = {
  continuedRunId: "run_continued",
  activeTriggerRunId: "run_continued",
};

describe("attaching to an automatic continuation", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("attaches when the chat still shows the stream the outage broke", () => {
    const { resumeStream, settle } = attach({ ...run, status: "error" });
    settle();

    expect(resumeStream).toHaveBeenCalledTimes(1);
  });

  it("retries a failed attach, a bounded number of times", () => {
    const { resumeStream, view, settle } = attach({ ...run, status: "ready" });
    settle();
    for (
      let attempt = 1;
      attempt <= AUTO_CONTINUE_ATTACH_ATTEMPTS + 1;
      attempt++
    ) {
      // The attempt starts, then fails.
      view.rerender({ ...run, status: "submitted" });
      view.rerender({ ...run, status: "error" });
      settle();
    }

    expect(resumeStream).toHaveBeenCalledTimes(AUTO_CONTINUE_ATTACH_ATTEMPTS);
  });

  it("retries when a reconnect fails without leaving error", async () => {
    const { resumeStream, settle } = attach({ ...run, status: "error" });
    for (
      let attempt = 1;
      attempt <= AUTO_CONTINUE_ATTACH_ATTEMPTS + 1;
      attempt++
    ) {
      settle();
      // Let the failed attempt settle; the status never changes.
      await act(async () => {});
    }

    expect(resumeStream).toHaveBeenCalledTimes(AUTO_CONTINUE_ATTACH_ATTEMPTS);
  });

  it("never attaches the same run again after it streamed", () => {
    const { resumeStream, view, settle } = attach({ ...run, status: "ready" });
    settle();
    view.rerender({ ...run, status: "streaming" });
    view.rerender({ ...run, status: "ready" });
    settle();

    expect(resumeStream).toHaveBeenCalledTimes(1);
  });

  it("does not attach a run the chat no longer runs", () => {
    const { resumeStream, settle } = attach({
      continuedRunId: "run_continued",
      activeTriggerRunId: "run_newer",
      status: "error",
    });
    settle();

    expect(resumeStream).not.toHaveBeenCalled();
  });
});
