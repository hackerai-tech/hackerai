import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AgentBrowserPreview } from "../AgentBrowserPreview";

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
  expect(screen.getByRole("button", { name: "Resume agent" })).toBeDisabled();
  view.unmount();
  expect(actions.map((body) => body.action)).toEqual(["take", "release"]);
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
  fireEvent.click(screen.getByRole("checkbox"));
  (global.fetch as jest.Mock).mockImplementationOnce(async () =>
    response({ state: "disconnected" }, false),
  );
  await act(async () => {
    jest.advanceTimersByTime(1600);
  });
  fireEvent.keyDown(screen.getByRole("application"), { key: "x" });
  expect(screen.getByRole("button", { name: "Resume agent" })).toBeDisabled();
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
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application"), { key: "4" });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
  });
  expect(actions.map((body) => body.action)).toEqual(["take", "input"]);
  fireEvent.keyDown(screen.getByRole("application"), { key: "2" });
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
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("application"), { key: "4" });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
  });
  await act(async () => {
    finishInput(response({ state: "expired" }, false));
  });
  expect(actions.some((body) => body.action === "resume")).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Browser input disconnected",
  );
});

it("allows explicit recovery resume only after identity confirmation", async () => {
  mockSession!.state = "recovery";
  await mount();
  expect(screen.getByRole("button", { name: "Resume agent" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
  });
  expect(actions.at(-1)).toMatchObject({
    action: "resume",
    grant: null,
    confirmedIdentity: true,
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

it("offers a route back to live control from an older tool", async () => {
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
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Return to live browser" }),
  );
  expect(jump).toHaveBeenCalledTimes(1);
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
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
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
  expect(screen.getByRole("application")).toBeVisible();
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
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
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
