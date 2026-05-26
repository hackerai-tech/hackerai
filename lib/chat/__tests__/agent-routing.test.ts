import {
  isHackerAIDesktopUserAgent,
  shouldUseAgentLongForAgent,
  shouldUseTriggerForChat,
} from "../agent-routing";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15 HackerAI-Desktop/1.0";

describe("agent routing", () => {
  test("detects the HackerAI desktop user agent token", () => {
    expect(isHackerAIDesktopUserAgent(DESKTOP_UA)).toBe(true);
    expect(isHackerAIDesktopUserAgent("Mozilla/5.0 Safari/605.1.15")).toBe(
      false,
    );
  });

  test("routes desktop agent mode with the HackerAI user agent through agent-long", () => {
    expect(
      shouldUseAgentLongForAgent({
        mode: "agent",
        subscription: "pro",
        isTauri: true,
        userAgent: DESKTOP_UA,
      }),
    ).toBe(true);
  });

  test("keeps the existing web and free-user Trigger.dev routing", () => {
    expect(
      shouldUseAgentLongForAgent({
        mode: "agent",
        subscription: "pro",
        isTauri: false,
      }),
    ).toBe(true);

    expect(
      shouldUseAgentLongForAgent({
        mode: "agent",
        subscription: "free",
        isTauri: true,
      }),
    ).toBe(true);
  });

  test("does not route non-agent modes or legacy desktop user agents through agent-long", () => {
    expect(
      shouldUseAgentLongForAgent({
        mode: "ask",
        subscription: "pro",
        isTauri: true,
        userAgent: DESKTOP_UA,
      }),
    ).toBe(false);

    expect(
      shouldUseAgentLongForAgent({
        mode: "agent",
        subscription: "pro",
        isTauri: true,
        userAgent: "Mozilla/5.0 Safari/605.1.15",
      }),
    ).toBe(false);
  });

  test("routes paid ask mode through Trigger.dev but keeps free ask on the chat route", () => {
    expect(
      shouldUseTriggerForChat({
        mode: "ask",
        subscription: "pro",
        isTauri: true,
      }),
    ).toBe(true);

    expect(
      shouldUseTriggerForChat({
        mode: "ask",
        subscription: "free",
        isTauri: false,
      }),
    ).toBe(false);
  });

  test("keeps existing agent Trigger.dev routing through the generalized predicate", () => {
    expect(
      shouldUseTriggerForChat({
        mode: "agent",
        subscription: "pro",
        isTauri: false,
      }),
    ).toBe(true);

    expect(
      shouldUseTriggerForChat({
        mode: "agent",
        subscription: "pro",
        isTauri: true,
        userAgent: "Mozilla/5.0 Safari/605.1.15",
      }),
    ).toBe(false);
  });
});
