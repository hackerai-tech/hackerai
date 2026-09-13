import { act, fireEvent, render, screen } from "@testing-library/react";
import { AgentWorkHeader } from "../AgentWorkHeader";

describe("AgentWorkHeader", () => {
  it("captures scroll before asking the timeline to expand", () => {
    const onCaptureScroll = jest.fn();
    const onToggle = jest.fn();

    render(
      <AgentWorkHeader
        canToggle
        durationMs={34_000}
        expanded={false}
        isTiming={false}
        messageId="assistant-1"
        onCaptureScroll={onCaptureScroll}
        onToggle={onToggle}
      />,
    );

    const trigger = screen.getByRole("button", { name: /worked for 34s/i });

    fireEvent.pointerDown(trigger);

    act(() => {
      fireEvent.click(trigger);
    });

    expect(onCaptureScroll).toHaveBeenCalledTimes(2);
    expect(onCaptureScroll).toHaveBeenNthCalledWith(1, trigger);
    expect(onCaptureScroll).toHaveBeenNthCalledWith(2, trigger);
    expect(onToggle).toHaveBeenCalledWith("assistant-1", true);
    expect(onCaptureScroll.mock.invocationCallOrder[1]).toBeLessThan(
      onToggle.mock.invocationCallOrder[0],
    );
  });
});
