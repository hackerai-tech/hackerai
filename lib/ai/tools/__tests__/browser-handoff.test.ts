import { asSchema } from "ai";
import { createBrowserHandoff } from "../browser-handoff";
import type { BrowserSessions } from "../utils/browser-sessions";

it.each([{}, { reason: "   " }])(
  "rejects an unexplained handoff before it can pause the browser: %j",
  async (input) => {
    const wait = jest.fn();
    const handoff = createBrowserHandoff({
      waitForHumanHandoff: wait,
    } as unknown as BrowserSessions);
    const validated = await asSchema(handoff.inputSchema).validate?.(input);
    if (validated?.success)
      await handoff.execute!(validated.value, {
        toolCallId: "handoff",
        messages: [],
      });
    expect(validated).toMatchObject({ success: false });
    expect(wait).not.toHaveBeenCalled();
  },
);
