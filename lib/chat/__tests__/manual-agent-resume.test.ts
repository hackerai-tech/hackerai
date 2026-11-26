import {
  resumeAnalyticsProperties,
  stoppedComputerReconnected,
} from "../manual-agent-resume";

describe("stoppedComputerReconnected", () => {
  const stopped = {
    finishReason: "local-connection-lost",
    savedSandboxPreference: "desktop-environment:env-a",
    sandboxPreference: "desktop-environment:env-a",
    computerUnavailableReason: undefined,
  };

  it("is true only when the stopped run's own computer is selected and connected", () => {
    expect(stoppedComputerReconnected(stopped)).toBe(true);
    // Another computer, or Cloud, coming online is not this computer's return.
    expect(
      stoppedComputerReconnected({
        ...stopped,
        sandboxPreference: "desktop-environment:env-b",
      }),
    ).toBe(false);
    expect(
      stoppedComputerReconnected({ ...stopped, sandboxPreference: "e2b" }),
    ).toBe(false);
    expect(
      stoppedComputerReconnected({
        ...stopped,
        computerUnavailableReason: "Checking your computer connection",
      }),
    ).toBe(false);
    expect(
      stoppedComputerReconnected({
        ...stopped,
        finishReason: "browser-handoff-abandoned",
      }),
    ).toBe(false);
    expect(
      stoppedComputerReconnected({
        ...stopped,
        savedSandboxPreference: undefined,
      }),
    ).toBe(false);
  });

  it("treats the legacy saved Desktop value as the Desktop selection", () => {
    expect(
      stoppedComputerReconnected({
        ...stopped,
        savedSandboxPreference: "tauri",
        sandboxPreference: "desktop",
      }),
    ).toBe(true);
  });
});

describe("resumeAnalyticsProperties", () => {
  it("reports only closed manual-resume reasons", () => {
    expect(resumeAnalyticsProperties("local-connection-lost")).toEqual({
      resume_from_finish_reason: "local-connection-lost",
      resume_trigger: "manual",
    });
    // HAC-275: the server's continuation is told apart from the user's.
    expect(
      resumeAnalyticsProperties("local-connection-lost", "automatic"),
    ).toEqual({
      resume_from_finish_reason: "local-connection-lost",
      resume_trigger: "automatic",
    });
    expect(resumeAnalyticsProperties("stop")).toBeUndefined();
    expect(resumeAnalyticsProperties(undefined)).toBeUndefined();
  });
});
