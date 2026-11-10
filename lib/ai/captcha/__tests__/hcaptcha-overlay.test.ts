/** @jest-environment-options {"url":"https://accounts.hcaptcha.com/demo"} */
import { createBrowserChallengeHandler } from "../browser-challenge";
import type { ToolContext } from "@/types";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";

jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(async () => true),
  phLogger: { event: jest.fn() },
}));

const originalKey = process.env.TWOCAPTCHA_API_KEY;
afterEach(() => {
  document.body.innerHTML = "";
  jest.restoreAllMocks();
  if (originalKey === undefined) delete process.env.TWOCAPTCHA_API_KEY;
  else process.env.TWOCAPTCHA_API_KEY = originalKey;
});

it.each([true, false])(
  "requires closing the hCaptcha overlay before spending (open at discovery=%s)",
  async (openAtDiscovery) => {
    process.env.TWOCAPTCHA_API_KEY = "synthetic-provider-key";
    jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(true);
    document.body.innerHTML = `<form><div class="h-captcha" data-sitekey="public-key"></div><textarea name="h-captcha-response"></textarea></form><iframe src="https://newassets.hcaptcha.com/captcha/hcaptcha.html#frame=challenge"></iframe>`;
    const overlay = document.querySelector("iframe")!;
    overlay.hidden = !openAtDiscovery;
    jest.spyOn(overlay, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          width: overlay.hidden ? 0 : 400,
          height: overlay.hidden ? 0 : 400,
        }) as DOMRect,
    );
    const field = document.querySelector("textarea")!;
    const dismiss = () => {
      overlay.hidden = true;
      // Models hCaptcha's challenge-cancel cleanup; applying a response before
      // this lifecycle transition would lose it before form submission.
      field.value = "";
    };
    const solve = jest.fn(async (_url, _widget, _signal, created, cost) => {
      await created(123);
      await cost(123, 0.00299);
      return { token: "synthetic-private-response", costDollars: 0.00299 };
    });
    const journal = {
      reserve: jest.fn(async () => true),
      registerTask: jest.fn(),
      recordCost: jest.fn(),
    };
    const context = {
      userID: "qa-user",
      triggerRunId: "qa-run",
      browserSessions: {
        getChallengeBrowser: async () => ({
          identity: "owned-browser",
          evaluate: async (script: string) => window.eval(script),
        }),
      },
    } as unknown as ToolContext;
    const handler = createBrowserChallengeHandler(
      context,
      "PREVIEW",
      undefined,
      () => ({ solve }),
      journal,
    );
    const target = { sandbox: {} as never, sessionName: "owned" };
    let preparation = await handler.inspect(undefined, target);
    if (!openAtDiscovery) {
      expect(preparation).toMatchObject({ status: "solve_available" });
      overlay.hidden = false;
      preparation = await handler.request("solve", "owned");
    }
    expect(preparation).toMatchObject({
      status: "preparation_required",
      providerTaskCreated: false,
    });
    expect(solve).not.toHaveBeenCalled();
    expect(journal.reserve).not.toHaveBeenCalled();
    dismiss();
    expect(await handler.inspect(undefined, target)).toMatchObject({
      status: "solve_available",
    });
    const result = await handler.request("solve", "owned");
    expect(result).toMatchObject({
      status: "token_delivered",
      responseRetained: true,
    });
    expect(solve).toHaveBeenCalledTimes(1);
    expect(journal.reserve).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("synthetic-private-response");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-response");
  },
);

it("reports when hCaptcha's callback clears the delivered field without charging again", async () => {
  process.env.TWOCAPTCHA_API_KEY = "synthetic-provider-key";
  document.body.innerHTML = `<form><div class="h-captcha" data-sitekey="public-key" data-callback="resetAfterCallback"></div><textarea name="h-captcha-response"></textarea></form>`;
  const page = window as unknown as Record<string, unknown>;
  page.resetAfterCallback = () => {
    document.querySelector("textarea")!.value = "";
  };
  try {
    const solve = jest.fn(async () => ({
      token: "synthetic-private-response",
      costDollars: 0.00299,
    }));
    const context = {
      userID: "qa-user",
      triggerRunId: "qa-run",
      browserSessions: {
        getChallengeBrowser: async () => ({
          identity: "owned",
          evaluate: async (script: string) => window.eval(script),
        }),
      },
    } as unknown as ToolContext;
    const handler = createBrowserChallengeHandler(
      context,
      "PREVIEW",
      undefined,
      () => ({ solve }),
      {
        reserve: async () => true,
        registerTask: jest.fn(),
        recordCost: jest.fn(),
      },
    );
    await handler.inspect(undefined, {
      sandbox: {} as never,
      sessionName: "owned",
    });
    const result = await handler.request("solve", "owned");
    expect(result).toMatchObject({
      status: "handoff_required",
      reason: "response_not_retained",
      responseDelivered: true,
      websiteAccepted: false,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-response");
    await handler.inspect(undefined, {
      sandbox: {} as never,
      sessionName: "owned",
    });
    expect(solve).toHaveBeenCalledTimes(1);
  } finally {
    delete page.resetAfterCallback;
  }
});
