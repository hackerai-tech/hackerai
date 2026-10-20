import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AgentBrowserPreview } from "../AgentBrowserPreview";
import { normalizeBrowserInputBatch } from "@/lib/ai/browser-handoff/input";

let mockSession: Record<string, unknown> | null;
jest.mock("convex/react", () => ({ useQuery: () => mockSession }));
jest.mock("@/convex/_generated/api", () => ({
  api: { browserHandoffs: { getForUser: "getForUser" } },
}));

const frame = {
  image: "data:image/png;base64,test",
  width: 800,
  height: 600,
  capturedAt: 1,
  browserSessionName: "default",
};
const response = (data: unknown, ok = true) =>
  ({ ok, json: async () => data }) as Response;
const originalFetch = global.fetch;
let actions: Array<Record<string, unknown>>;
let handleAction: (body: Record<string, unknown>) => Promise<Response>;

async function mount() {
  const view = render(
    <AgentBrowserPreview chatId="chat" agentId="parent" liveSelection />,
  );
  await act(async () => {});
  return view;
}

async function takeControl() {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Take control of Agent browser" }),
    );
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  sessionStorage.clear();
  mockSession = { sessionId: "session-a", state: "agent" };
  actions = [];
  handleAction = async (body) =>
    response(body.action === "take" ? { grant: "grant-a", frame } : { frame });
  global.fetch = jest.fn(async (_url, options) => {
    if (!options?.body) return response({ frame });
    const body = JSON.parse(String(options.body));
    actions.push(body);
    return handleAction(body);
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

it("releases control without resuming when the sidebar closes", async () => {
  const view = await mount();
  await takeControl();
  expect(screen.getByRole("button", { name: "Exit takeover" })).toBeEnabled();
  view.unmount();
  expect(actions.map((body) => body.action)).toEqual(["take", "release"]);
});

it("allows takeover while the Agent is waiting for the user", async () => {
  mockSession = { sessionId: "session-a", state: "waiting" };
  await mount();
  expect(screen.getByText("Waiting for you")).toBeInTheDocument();
  await takeControl();
  expect(screen.getByRole("button", { name: "Exit takeover" })).toBeEnabled();
});

it("releases a takeover that completes after the sidebar closes", async () => {
  let finish!: (value: Response) => void;
  handleAction = (body) =>
    body.action === "take"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(response({}));
  const view = await mount();
  await takeControl();
  view.unmount();
  await act(async () => {
    finish(response({ grant: "late-grant", frame }));
  });
  expect(actions.at(-1)).toEqual({ action: "release", grant: "late-grant" });
});

it("stops input and resume when the preview disconnects", async () => {
  await mount();
  await takeControl();
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
  (global.fetch as jest.Mock).mockImplementationOnce(async () =>
    response({ state: "disconnected" }, false),
  );
  await act(async () => {
    jest.advanceTimersByTime(1600);
  });
  fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
    key: "x",
  });
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  expect(
    screen.getByRole("button", { name: "Send and continue" }),
  ).toBeDisabled();
  expect(actions.some((body) => body.action === "input")).toBe(false);
});

it("waits for queued keystrokes before resuming and stops accepting new input", async () => {
  let finishInput!: (value: Response) => void;
  handleAction = (body) =>
    body.action === "input"
      ? new Promise((resolve) => {
          finishInput = resolve;
        })
      : Promise.resolve(response({ grant: "grant-a", frame }));
  await mount();
  await takeControl();
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
      key: "4",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(actions.map((body) => body.action)).toEqual(["take", "input"]);
  fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
    key: "2",
  });
  await act(async () => {
    finishInput(response({ ok: true }));
  });
  expect(actions.map((body) => body.action)).toEqual([
    "take",
    "input",
    "resume",
  ]);
});

it("keeps recovery paused if the final queued input fails", async () => {
  let finishInput!: (value: Response) => void;
  handleAction = (body) =>
    body.action === "input"
      ? new Promise((resolve) => {
          finishInput = resolve;
        })
      : Promise.resolve(response({ grant: "grant-a", frame }));
  await mount();
  await takeControl();
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
      key: "4",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  await act(async () => {
    finishInput(response({ state: "expired" }, false));
  });
  expect(actions.some((body) => body.action === "resume")).toBe(false);
  expect(
    screen
      .getAllByRole("alert")
      .some((alert) =>
        alert.textContent?.includes("Browser input disconnected"),
      ),
  ).toBe(true);
});

it("allows recovery to continue with an empty optional note", async () => {
  mockSession!.state = "recovery";
  await mount();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(actions.at(-1)).toMatchObject({
    action: "resume",
    grant: null,
    note: "",
    requestId: expect.any(String),
  });
});

it("explains an ended browser run instead of removing all handoff controls", async () => {
  mockSession = null;
  render(
    <AgentBrowserPreview
      chatId="chat"
      agentId="parent"
      liveSelection
      browserRequested
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Session ended");
  expect(
    screen.getByRole("button", { name: "Take control of Agent browser" }),
  ).toBeDisabled();
  expect(screen.getByText(/Ask the Agent to reopen the page/)).toBeVisible();
});

it("keeps the unavailable browser explanation specific to browser tools", () => {
  mockSession = null;
  render(<AgentBrowserPreview chatId="chat" agentId="parent" liveSelection />);
  expect(
    screen.queryByRole("region", { name: "Agent browser preview" }),
  ).not.toBeInTheDocument();
});

it("takes the current browser directly from earlier tool history", async () => {
  const jump = jest.fn();
  render(
    <AgentBrowserPreview
      chatId="chat"
      agentId="parent"
      liveSelection={false}
      onJumpToLive={jump}
    />,
  );
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Take control of Agent browser" }),
  ).toBeEnabled();
  await takeControl();
  expect(jump).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("application")).toBeVisible();
  expect(actions.filter((body) => body.action === "take")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(actions.at(-1)?.action).toBe("resume");
});

it("opens fullscreen immediately while withholding input until takeover is confirmed", async () => {
  let finish!: (value: Response) => void;
  handleAction = (body) =>
    body.action === "take"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(response({}));
  await mount();
  await takeControl();
  expect(screen.getByRole("dialog", { name: "Browser control" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Requesting control");
  expect(screen.queryByRole("application")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Exit takeover" })).toBeDisabled();
  await act(async () => {
    finish(response({ grant: "grant-a", frame }));
  });
  expect(screen.getByRole("application")).toBeVisible();
  expect(screen.getByRole("button", { name: "Exit takeover" })).toBeEnabled();
});

it("returns to the preview with a retryable error when initial takeover fails", async () => {
  handleAction = async () => response({ error: "Connection failed" }, false);
  await mount();
  await takeControl();
  expect(
    screen.queryByRole("dialog", { name: "Browser control" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Connection failed");
  expect(
    screen.getByRole("button", { name: "Take control of Agent browser" }),
  ).toBeEnabled();
});

it("keeps a new session usable when an older resume fails late", async () => {
  let failResume!: (value: Response) => void;
  handleAction = (body) =>
    body.action === "resume"
      ? new Promise((resolve) => {
          failResume = resolve;
        })
      : Promise.resolve(response({ grant: mockSession?.sessionId, frame }));
  const view = await mount();
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  mockSession = { sessionId: "session-b", state: "agent" };
  view.rerender(
    <AgentBrowserPreview chatId="chat" agentId="parent" liveSelection />,
  );
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Take control of Agent browser" }),
  ).toBeEnabled();
  await takeControl();
  await act(async () => {
    failResume(response({ state: "expired" }, false));
  });
  expect(screen.getByRole("application", { hidden: true })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("ignores old resume failures before the new session's passive effects run", async () => {
  let failResume!: (value: Response) => void;
  handleAction = (body) =>
    body.action === "resume"
      ? new Promise((resolve) => {
          failResume = resolve;
        })
      : Promise.resolve(response({ grant: "grant-a", frame }));
  const view = await mount();
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  // Model a commit whose passive effects have not yet been scheduled by React.
  const effects: React.EffectCallback[] = [];
  const useEffect = React.useEffect;
  const delayed = jest
    .spyOn(React, "useEffect")
    .mockImplementation((effect, deps) => {
      useEffect(() => {
        effects.push(effect);
      }, deps);
    });
  try {
    mockSession = { sessionId: "session-b", state: "agent" };
    view.rerender(
      <AgentBrowserPreview chatId="chat" agentId="parent" liveSelection />,
    );
    await act(async () => {
      failResume(response({ state: "expired" }, false));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    delayed.mockRestore();
    // Deferred effects were intentionally never started; unmount cleans up the
    // effects that were installed before the session changed.
    view.unmount();
  }
});

it("opens full-screen control with only an Exit takeover overlay and restores focus on cancel", async () => {
  await mount();
  await takeControl();
  expect(screen.getByRole("dialog", { name: "Browser control" })).toBeVisible();
  expect(screen.getByRole("application", { hidden: true })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
    key: "Escape",
  });
  expect(screen.getByRole("button", { name: "Exit takeover" })).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: "Back to chat" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Agent paused. Click, type/),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  expect(screen.getByRole("application", { hidden: true })).toHaveFocus();
  expect(screen.getByRole("dialog", { name: "Browser control" })).toBeVisible();
  expect(actions.map((body) => body.action)).toEqual(["take"]);
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
      key: "A",
    });
  });
  expect(actions.at(-1)).toMatchObject({
    action: "input",
    grant: "grant-a",
    inputs: [{ kind: "text", text: "A" }],
  });
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(actions.map((body) => body.action)).toEqual([
    "take",
    "input",
    "resume",
  ]);
});

it("keeps the user in chat when takeover fails", async () => {
  handleAction = async () => response({ state: "unavailable" }, false);
  await mount();
  await takeControl();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
});

it("maps full-screen clicks and scrolling to the displayed browser pixels", async () => {
  await mount();
  await takeControl();
  const image = screen.getByRole("img", {
    name: "Current Agent browser viewport",
  });
  image.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: 400, height: 300 }) as DOMRect;
  Object.defineProperty(image, "naturalWidth", { value: 800 });
  Object.defineProperty(image, "naturalHeight", { value: 600 });
  image.setPointerCapture = jest.fn();
  image.releasePointerCapture = jest.fn();
  // jsdom does not implement PointerEvent; provide mouse coordinates directly.
  const down = new MouseEvent("pointerdown", {
    bubbles: true,
    clientX: 300,
    clientY: 200,
  });
  const up = new MouseEvent("pointerup", {
    bubbles: true,
    clientX: 300,
    clientY: 200,
  });
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: 300,
    clientY: 200,
    deltaY: 3,
    deltaMode: 1,
  });
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
  screen.getByRole("button", { name: "Exit takeover" }).focus();
  await act(async () => {
    fireEvent(image, down);
    fireEvent(image, up);
    fireEvent(image, wheel);
  });
  expect(
    screen.getByRole("textbox", {
      name: "Type in remote browser",
      hidden: true,
    }),
  ).toHaveFocus();
  expect(wheel.defaultPrevented).toBe(true);
  expect(
    actions
      .filter((body) => body.action === "input")
      .flatMap((body) => body.inputs),
  ).toEqual([
    { kind: "down", x: 400, y: 300 },
    { kind: "up", x: 400, y: 300 },
    { kind: "wheel", x: 400, y: 300, deltaX: 0, deltaY: 48 },
  ]);
});

it("batches rapid typing in order and drains the entire burst before resuming", async () => {
  const finish: Array<(value: Response) => void> = [];
  handleAction = (body) =>
    body.action === "input"
      ? new Promise((resolve) => finish.push(resolve))
      : Promise.resolve(response({ grant: "grant-a", frame }));
  await mount();
  await takeControl();
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
      key: "a",
    });
  });
  await act(async () => {
    for (const key of ".b@c-d!AZ")
      fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
        key,
      });
  });
  expect(actions.filter((body) => body.action === "input")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  await act(async () => {
    finish[0](response({ ok: true }));
  });
  expect(actions.map((body) => body.action)).toEqual([
    "take",
    "input",
    "input",
  ]);
  expect(actions[2].inputs).toEqual(
    [...".b@c-d!AZ"].map((text) => ({ kind: "text", text })),
  );
  await act(async () => {
    finish[1](response({ ok: true }));
  });
  expect(actions.at(-1)?.action).toBe("resume");
});

it.each([
  ["chunk boundary", "a".repeat(31) + "😀Z", "a".repeat(31) + "😀Z"],
  ["size limit", "a".repeat(2046) + "😀", "a".repeat(2046) + "😀"],
])(
  "preserves complete Unicode characters at the %s",
  async (_label, text, expected) => {
    await mount();
    await takeControl();
    await act(async () => {
      fireEvent.paste(screen.getByRole("application", { hidden: true }), {
        clipboardData: { getData: () => text },
      });
    });
    const chunks = actions
      .filter((body) => body.action === "input")
      .flatMap((body) => body.inputs as Array<{ text: string }>);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(expected);
    for (const chunk of chunks) {
      expect([...chunk.text].length).toBeLessThanOrEqual(32);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  },
);

it("keeps an optional note when the run ends and starts a continuation with the saved message", async () => {
  const onContinue = jest.fn(async () => undefined);
  const view = render(
    <AgentBrowserPreview
      chatId="chat"
      agentId="parent"
      liveSelection
      onContinue={onContinue}
    />,
  );
  await act(async () => {});
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Signed in as my test user." },
  });
  mockSession = null;
  view.rerender(
    <AgentBrowserPreview
      chatId="chat"
      agentId="parent"
      liveSelection
      onContinue={onContinue}
    />,
  );
  await act(async () => {
    jest.advanceTimersByTime(15_000);
  });
  expect(
    actions.filter((action) => action.action === "heartbeat"),
  ).toHaveLength(0);
  expect(screen.queryByText(/Control expired/)).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("Signed in as my test user.");
  handleAction = async () =>
    response({
      restart: true,
      continuation: { id: "saved-note", text: "Saved context" },
    });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(actions.at(-1)).toMatchObject({
    action: "resume",
    note: "Signed in as my test user.",
  });
  expect(onContinue).toHaveBeenCalledWith({
    id: "saved-note",
    text: "Saved context",
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("retains a failed continuation and reuses its request id without duplicate sends", async () => {
  const onContinue = jest
    .fn<Promise<void>, [{ id: string; text: string }]>()
    .mockRejectedValueOnce(new Error("Start unavailable"))
    .mockResolvedValueOnce(undefined);
  const view = render(
    <AgentBrowserPreview
      chatId="chat"
      agentId="parent"
      liveSelection
      onContinue={onContinue}
    />,
  );
  await act(async () => {});
  await takeControl();
  mockSession = null;
  view.rerender(
    <AgentBrowserPreview
      chatId="chat"
      agentId="parent"
      liveSelection
      onContinue={onContinue}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Completed the form" },
  });
  handleAction = async () =>
    response({
      restart: true,
      continuation: { id: "saved-note", text: "Saved context" },
    });
  await act(async () => {
    const send = screen.getByRole("button", { name: "Send and continue" });
    fireEvent.click(send);
    fireEvent.click(send);
  });
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox")).toHaveValue("Completed the form");
  const firstId = actions.at(-1)?.requestId;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(actions.at(-1)?.requestId).toBe(firstId);
  expect(onContinue).toHaveBeenCalledTimes(2);
});

it("keeps a new takeover and its draft when an old continuation finishes late", async () => {
  let finish!: () => void;
  const onContinue = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const props = {
    chatId: "chat",
    agentId: "parent",
    liveSelection: true,
    onContinue,
  };
  const view = render(<AgentBrowserPreview {...props} />);
  await act(async () => {});
  await takeControl();
  mockSession = null;
  view.rerender(<AgentBrowserPreview {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  handleAction = async (body) =>
    response(
      body.action === "resume"
        ? { restart: true, continuation: { id: "old-note", text: "Old note" } }
        : { grant: "grant-b", frame },
    );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(onContinue).toHaveBeenCalledTimes(1);
  mockSession = { sessionId: "session-b", state: "agent" };
  view.rerender(<AgentBrowserPreview {...props} />);
  await act(async () => {});
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "New session draft!" },
  });
  await act(async () => {
    finish();
  });
  expect(screen.getByRole("textbox")).toHaveValue("New session draft!");
  expect(
    screen.getByRole("button", { name: "Send and continue" }),
  ).toBeEnabled();
});

it("sends ordered takeover input directly to the relay instead of the command API", async () => {
  handleAction = async (body) =>
    response(
      body.action === "take"
        ? { grant: "grant-a", frame, relayUrl: "https://relay.example" }
        : {},
    );
  const originalMock = global.fetch as jest.Mock;
  const defaultFetch = originalMock.getMockImplementation()!;
  const relayInputs: Array<{ sequence: number; inputs: unknown[] }> = [];
  originalMock.mockImplementation(async (url, options) => {
    if (url === "https://relay.example/frames") return new Promise(() => {});
    if (url === "https://relay.example/input") {
      relayInputs.push(JSON.parse(options.body));
      return response({ ok: true });
    }
    return defaultFetch(url, options);
  });
  await mount();
  await takeControl();
  for (const key of ["A", "@", "!"]) {
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
        key,
      });
    });
  }
  expect(relayInputs).toEqual([
    { sequence: 1, inputs: [{ kind: "text", text: "A" }] },
    { sequence: 2, inputs: [{ kind: "text", text: "@" }] },
    { sequence: 3, inputs: [{ kind: "text", text: "!" }] },
  ]);
  expect(actions.some((body) => body.action === "input")).toBe(false);
});

it("reconnects lost control in full screen and preserves the unsent exit note", async () => {
  await mount();
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Filled the form." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  mockSession!.state = "human";
  mockSession!.grantExpiresAt = Date.now() + 30_000;
  handleAction = async (body) =>
    body.action === "input"
      ? response({ state: "expired" }, false)
      : response({ grant: "grant-b", frame });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
      key: "x",
    });
  });
  expect(
    screen.getByRole("button", { name: "Reconnect control" }),
  ).toBeDisabled();
  await act(async () => {
    jest.advanceTimersByTime(31_000);
  });
  await act(async () => {
    jest.advanceTimersByTime(1600);
  });
  expect(
    screen.getByRole("button", { name: "Reconnect control" }),
  ).toBeEnabled();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reconnect control" }));
  });
  expect(screen.getByRole("application", { hidden: true })).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: "Reconnect control" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application", { hidden: true }), {
      key: "A",
    });
  });
  expect(actions.at(-1)).toMatchObject({ action: "input", grant: "grant-b" });
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  expect(screen.getByRole("textbox")).toHaveValue("Filled the form.");
});

it.each(["x".repeat(2049), "a".repeat(2047) + "😀"])(
  "rejects an oversized paste without partially entering it",
  async (text) => {
    await mount();
    await takeControl();
    await act(async () => {
      fireEvent.paste(screen.getByRole("application", { hidden: true }), {
        clipboardData: { getData: () => text },
      });
    });
    expect(actions.some((body) => body.action === "input")).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was pasted");
    await act(async () => {
      fireEvent.paste(screen.getByRole("application", { hidden: true }), {
        clipboardData: { getData: () => "A.b@C-d!\r\n日本語 😀" },
      });
    });
    expect(actions.at(-1)).toMatchObject({
      inputs: [{ kind: "text", text: "A.b@C-d!\n日本語 😀" }],
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it("restores an unsent exit note after remount and clears it after successful resume", async () => {
  const first = await mount();
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Draft after reconnect." },
  });
  first.unmount();
  mockSession!.state = "recovery";
  const recovered = await mount();
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  expect(screen.getByRole("textbox")).toHaveValue("Draft after reconnect.");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  expect(actions.at(-1)).toMatchObject({
    action: "resume",
    note: "Draft after reconnect.",
  });
  recovered.unmount();
  await mount();
  await takeControl();
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  expect(screen.getByRole("textbox")).toHaveValue("");
});

it.each([32, 63])(
  "pastes %i newlines without exceeding the server wire-size limit",
  async (count) => {
    handleAction = async (body) =>
      body.action === "input"
        ? response({}, !!normalizeBrowserInputBatch(body.inputs))
        : response({ grant: "grant-a", frame });
    await mount();
    await takeControl();
    await act(async () => {
      fireEvent.paste(screen.getByRole("application", { hidden: true }), {
        clipboardData: { getData: () => "\n".repeat(count) },
      });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const sent = actions.filter((body) => body.action === "input");
    expect(
      sent.every((body) => normalizeBrowserInputBatch(body.inputs) !== null),
    ).toBe(true);
    expect(
      sent
        .flatMap((body) => body.inputs as Array<{ text: string }>)
        .map((input) => input.text)
        .join(""),
    ).toBe("\n".repeat(count));
  },
);

it("can submit the note when browser storage is blocked", async () => {
  const get = jest
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  const set = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  const remove = jest
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  try {
    await mount();
    await takeControl();
    fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Storage unavailable, context still submitted." },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send and continue" }),
      );
    });
    expect(actions.at(-1)).toMatchObject({
      action: "resume",
      note: "Storage unavailable, context still submitted.",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  } finally {
    get.mockRestore();
    set.mockRestore();
    remove.mockRestore();
  }
});

it("ignores a heartbeat failure while ownership is being returned", async () => {
  await mount();
  await takeControl();
  let rejectHeartbeat!: (error: Error) => void;
  let finishResume!: (response: Response) => void;
  handleAction = async (body) => {
    if (body.action === "heartbeat")
      return new Promise((_resolve, reject) => {
        rejectHeartbeat = reject;
      });
    if (body.action === "resume")
      return new Promise((resolve) => {
        finishResume = resolve;
      });
    return response({ frame });
  };
  await act(async () => {
    jest.advanceTimersByTime(10_000);
  });
  fireEvent.click(screen.getByRole("button", { name: "Exit takeover" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send and continue" }));
  });
  await act(async () => {
    rejectHeartbeat(new Error("Grant revoked by resume"));
  });
  expect(screen.queryByText(/Control expired/)).not.toBeInTheDocument();
  await act(async () => {
    finishResume(response({ frame }));
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(/Control expired/)).not.toBeInTheDocument();
});

it.each([false, true])(
  "reports unavailable for a non-JSON response (ok: %s)",
  async (ok) => {
    await mount();
    handleAction = async () =>
      ({
        ok,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }) as Response;
    await takeControl();
    expect(screen.getByRole("alert")).toHaveTextContent("Browser unavailable");
    expect(
      screen.getByRole("button", { name: "Take control of Agent browser" }),
    ).toBeEnabled();
  },
);

it.each([null, [], "gateway error"])(
  "rejects malformed successful response %p",
  async (body) => {
    await mount();
    handleAction = async () => response(body);
    await takeControl();
    expect(screen.getByRole("alert")).toHaveTextContent("Browser unavailable");
  },
);

it("resizes to the visible phone viewport and coalesces rotation before accepting clicks", async () => {
  const viewport = new EventTarget() as VisualViewport;
  Object.assign(viewport, {
    width: 390,
    height: 844,
    offsetTop: 0,
    offsetLeft: 0,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  try {
    await mount();
    await takeControl();
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(actions.at(-1)).toMatchObject({
      action: "viewport",
      width: 390,
      height: 844,
      grant: "grant-a",
    });
    expect(
      screen.getByRole("button", { name: "Show browser keyboard" }),
    ).toBeEnabled();
    await act(async () => {
      Object.assign(viewport, { width: 844, height: 390 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await act(async () => {
      Object.assign(viewport, { width: 844, height: 350 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(actions.filter((a) => a.action === "viewport")).toEqual([
      { action: "viewport", width: 390, height: 844, grant: "grant-a" },
      { action: "viewport", width: 844, height: 350, grant: "grant-a" },
    ]);
    expect(screen.getByRole("dialog", { name: "Browser control" })).toHaveStyle(
      { width: "844px", height: "350px" },
    );
  } finally {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
  }
});

it("commits IME text once without sending intermediate composition or Process keys", async () => {
  await mount();
  await takeControl();
  const keyboard = screen.getByRole("textbox", {
    name: "Type in remote browser",
    hidden: true,
  });
  await act(async () => {
    fireEvent.compositionStart(keyboard);
    fireEvent.keyDown(keyboard, {
      key: "Process",
      code: "KeyA",
      isComposing: true,
    });
    fireEvent.input(keyboard, {
      target: { value: "に" },
      inputType: "insertCompositionText",
      isComposing: true,
    });
  });
  expect(actions.filter((a) => a.action === "input")).toEqual([]);
  await act(async () => {
    fireEvent.input(keyboard, {
      target: { value: "日本語🙂" },
      inputType: "insertCompositionText",
      isComposing: true,
    });
    fireEvent.compositionEnd(keyboard, { data: "日本語🙂" });
    fireEvent.input(keyboard, {
      inputType: "insertFromComposition",
      data: "日本語🙂",
    });
  });
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([{ kind: "text", text: "日本語🙂" }]);
});

it("forwards soft-keyboard input, deletion and return without requiring keydown", async () => {
  await mount();
  await takeControl();
  const keyboard = screen.getByRole("textbox", {
    name: "Type in remote browser",
    hidden: true,
  });
  for (const [value, inputType] of [
    ["AZ!?", "insertText"],
    ["", "deleteContentBackward"],
    ["\n", "insertLineBreak"],
  ]) {
    await act(async () => {
      fireEvent.input(keyboard, { target: { value }, inputType });
    });
  }
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([
    { kind: "text", text: "AZ!?" },
    { kind: "key", key: "Backspace", code: "Backspace", modifiers: 0 },
    { kind: "key", key: "Enter", code: "Enter", modifiers: 0 },
  ]);
});

it("scrolls touch swipes without clicking and sends a tap only on release", async () => {
  await mount();
  await takeControl();
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
  const image = screen.getByAltText(
    "Current Agent browser viewport",
  ) as HTMLImageElement;
  image.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
  image.setPointerCapture = jest.fn();
  image.releasePointerCapture = jest.fn();
  const touch = async (type: string, y: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: y,
    });
    Object.defineProperties(event, {
      pointerType: { value: "touch" },
      pointerId: { value: 1 },
    });
    await act(async () => {
      fireEvent(image, event);
    });
  };
  await touch("pointerdown", 300);
  await touch("pointermove", 200);
  await touch("pointerup", 200);
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([{ kind: "wheel", x: 100, y: 200, deltaX: 0, deltaY: 100 }]);
  actions.length = 0;
  await touch("pointerdown", 200);
  expect(actions).toEqual([]);
  await touch("pointerup", 200);
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([
    { kind: "down", x: 100, y: 200 },
    { kind: "up", x: 100, y: 200 },
  ]);
});

it("lets Android unidentified key events reach native input instead of cancelling them", async () => {
  await mount();
  await takeControl();
  const keyboard = screen.getByRole("textbox", {
    name: "Type in remote browser",
    hidden: true,
  });
  const key = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Unidentified",
    keyCode: 229,
  });
  await act(async () => {
    fireEvent(keyboard, key);
  });
  expect(key.defaultPrevented).toBe(false);
  expect(actions.filter((a) => a.action === "input")).toEqual([]);
  await act(async () => {
    fireEvent.input(keyboard, {
      target: { value: "Android" },
      inputType: "insertText",
    });
  });
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([{ kind: "text", text: "Android" }]);
});

it("never leaks a keyboard placeholder into the remote input", async () => {
  await mount();
  await takeControl();
  const keyboard = screen.getByRole("textbox", {
    name: "Type in remote browser",
    hidden: true,
  }) as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.input(keyboard, {
      target: { value: `P${keyboard.value}` },
      inputType: "insertText",
    });
  });
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([{ kind: "text", text: "P" }]);
});

it("handles soft-keyboard backspace on an empty bridge before the browser drops the input event", async () => {
  await mount();
  await takeControl();
  const keyboard = screen.getByRole("textbox", {
    name: "Type in remote browser",
    hidden: true,
  });
  const deletion = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "deleteContentBackward",
  });
  await act(async () => {
    fireEvent(keyboard, deletion);
  });
  expect(deletion.defaultPrevented).toBe(true);
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([
    { kind: "key", key: "Backspace", code: "Backspace", modifiers: 0 },
  ]);
});
it("preserves user-provided zero-width characters", async () => {
  await mount();
  await takeControl();
  const keyboard = screen.getByRole("textbox", {
    name: "Type in remote browser",
    hidden: true,
  });
  await act(async () => {
    fireEvent.input(keyboard, {
      target: { value: "A\u200bB" },
      inputType: "insertText",
    });
  });
  expect(
    actions.filter((a) => a.action === "input").flatMap((a) => a.inputs),
  ).toEqual([{ kind: "text", text: "A\u200bB" }]);
});
