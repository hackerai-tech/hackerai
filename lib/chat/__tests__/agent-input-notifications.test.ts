import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  MAX_AGENT_INPUT_NOTIFICATION_RECEIPTS,
  agentInputChatPath,
  claimAgentInputNotificationReceipt,
  createAgentInputNotificationTracker,
  deliverAgentInputNotification,
  isDocumentForeground,
} from "../agent-input-notifications";

const question = {
  chatId: "chat-1",
  requestId: '["question","run-1","tool-1"]',
};
const approval = { chatId: "chat-1", requestId: '["approval","run-1","ap-1"]' };
const other = { chatId: "chat-2", requestId: '["question","run-2","tool-2"]' };

describe("createAgentInputNotificationTracker", () => {
  it("treats the first snapshot as a baseline and reports only later waits", () => {
    const tracker = createAgentInputNotificationTracker();

    expect(tracker.observe(undefined)).toEqual([]);
    expect(tracker.observe([question])).toEqual([]);
    expect(tracker.observe([question, approval, other])).toEqual([
      approval,
      other,
    ]);
    expect(tracker.observe([question, approval, other])).toEqual([]);
  });

  it("does not report a seen wait again after loading or a reconnect", () => {
    const tracker = createAgentInputNotificationTracker();
    tracker.observe([]);
    expect(tracker.observe([question])).toEqual([question]);

    expect(tracker.observe(undefined)).toEqual([]);
    expect(tracker.observe([])).toEqual([]);
    expect(tracker.observe([question])).toEqual([]);
  });

  it("reports a duplicated request once", () => {
    const tracker = createAgentInputNotificationTracker();
    tracker.observe([]);

    expect(tracker.observe([question, question])).toEqual([question]);
  });

  it("never forgets a wait that stays pending while many others finish", () => {
    const tracker = createAgentInputNotificationTracker();
    tracker.observe([question]);

    for (let index = 0; index < 600; index++) {
      const passing = { chatId: "chat-2", requestId: `passing-${index}` };
      expect(tracker.observe([question, passing])).toEqual([passing]);
    }
  });
});

describe("agentInputChatPath", () => {
  it.each([
    [
      "0f8fad5b-d9cb-469f-a165-70867728950e",
      "/c/0f8fad5b-d9cb-469f-a165-70867728950e",
    ],
    ["legacy_chat-1", "/c/legacy_chat-1"],
    ["release.notes v2", "/c/release.notes%20v2"],
    ["a".repeat(256), `/c/${"a".repeat(256)}`],
  ])("routes %j as one encoded segment", (chatId, path) => {
    expect(agentInputChatPath(chatId)).toBe(path);
  });

  it.each([
    "",
    ".",
    "..",
    "chat/../settings",
    "https://example.com/c/chat",
    "chat\\settings",
    "chat?next=/settings",
    "chat#top",
    "chat\nid",
    "chat\u007f",
    "\ud800",
    // 258 UTF-8 bytes, matching the Desktop byte limit.
    "é".repeat(129),
  ])("rejects %j", (chatId) => {
    expect(agentInputChatPath(chatId)).toBeNull();
  });
});

describe("claimAgentInputNotificationReceipt", () => {
  beforeEach(() => window.localStorage.clear());

  it("lets only one window claim a request for an account", () => {
    expect(
      claimAgentInputNotificationReceipt(
        localStorage,
        "user-1",
        question.requestId,
      ),
    ).toBe(true);
    expect(
      claimAgentInputNotificationReceipt(
        localStorage,
        "user-1",
        question.requestId,
      ),
    ).toBe(false);
    expect(
      claimAgentInputNotificationReceipt(
        localStorage,
        "user-2",
        question.requestId,
      ),
    ).toBe(true);
  });

  it("keeps a bounded ledger of the most recent receipts", () => {
    for (
      let index = 0;
      index <= MAX_AGENT_INPUT_NOTIFICATION_RECEIPTS;
      index++
    ) {
      claimAgentInputNotificationReceipt(
        localStorage,
        "user-1",
        `request-${index}`,
      );
    }
    const stored = JSON.parse(
      localStorage.getItem("agent_input_notification_receipts:v1:user-1")!,
    );

    expect(stored).toHaveLength(MAX_AGENT_INPUT_NOTIFICATION_RECEIPTS);
    expect(stored).not.toContain("request-0");
    expect(stored).toContain(
      `request-${MAX_AGENT_INPUT_NOTIFICATION_RECEIPTS}`,
    );
  });

  it("does not claim when storage rejects or drops the receipt", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    const dropping = {
      getItem: () => null,
      setItem: () => undefined,
    } as unknown as Storage;

    expect(claimAgentInputNotificationReceipt(throwing, "user-1", "r")).toBe(
      false,
    );
    expect(claimAgentInputNotificationReceipt(dropping, "user-1", "r")).toBe(
      false,
    );
  });
});

describe("deliverAgentInputNotification", () => {
  let held = false;
  let request: jest.Mock<
    (name: string, callback: () => Promise<unknown>) => Promise<unknown>
  >;

  beforeEach(() => {
    window.localStorage.clear();
    held = false;
    // Serializes callers like the Web Locks API and records when it is held.
    let tail = Promise.resolve();
    request = jest.fn((_name: string, callback: () => Promise<unknown>) => {
      const run = tail.then(async () => {
        held = true;
        try {
          return await callback();
        } finally {
          held = false;
        }
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
  });
  afterEach(() => {
    delete (navigator as { locks?: unknown }).locks;
  });

  it("does not deliver without Web Locks", async () => {
    delete (navigator as { locks?: unknown }).locks;
    const show = jest.fn(() => true);

    await expect(
      deliverAgentInputNotification({
        userId: "user-1",
        requestId: question.requestId,
        shouldDeliver: () => true,
        show,
      }),
    ).resolves.toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(
      localStorage.getItem("agent_input_notification_receipts:v1:user-1"),
    ).toBeNull();
  });

  it("holds the lock only for the claim, not while showing", async () => {
    let heldWhileShowing: boolean | null = null;

    await deliverAgentInputNotification({
      userId: "user-1",
      requestId: question.requestId,
      shouldDeliver: () => true,
      show: () => {
        heldWhileShowing = held;
        return true;
      },
    });

    expect(heldWhileShowing).toBe(false);
  });

  it("does not show when the wait resolves after the claim", async () => {
    let pending = true;
    const show = jest.fn(() => true);
    request.mockImplementationOnce(async (_name, callback) => {
      const claimed = await callback();
      pending = false;
      return claimed;
    });

    await expect(
      deliverAgentInputNotification({
        userId: "user-1",
        requestId: question.requestId,
        shouldDeliver: () => pending,
        show,
      }),
    ).resolves.toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it("shows once when windows race under the account lock", async () => {
    const show = jest.fn(async () => true);

    const results = await Promise.all(
      [0, 1].map(() =>
        deliverAgentInputNotification({
          userId: "user-1",
          requestId: question.requestId,
          shouldDeliver: () => true,
          show,
        }),
      ),
    );

    expect(results.sort()).toEqual([false, true]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "hackerai-agent-input:user-1",
      expect.any(Function),
    );
  });

  it("rechecks before claiming, so a declined request records no receipt", async () => {
    const show = jest.fn(() => true);

    await expect(
      deliverAgentInputNotification({
        userId: "user-1",
        requestId: question.requestId,
        shouldDeliver: () => false,
        show,
      }),
    ).resolves.toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(
      localStorage.getItem("agent_input_notification_receipts:v1:user-1"),
    ).toBeNull();
  });
});

describe("isDocumentForeground", () => {
  it("requires a visible and focused document", () => {
    const doc = (visibilityState: string, focused: boolean) =>
      ({ visibilityState, hasFocus: () => focused }) as unknown as Document;

    expect(isDocumentForeground(doc("visible", true))).toBe(true);
    expect(isDocumentForeground(doc("visible", false))).toBe(false);
    expect(isDocumentForeground(doc("hidden", true))).toBe(false);
  });
});
