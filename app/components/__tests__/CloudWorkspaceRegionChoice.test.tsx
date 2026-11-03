import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CloudWorkspaceRegionChoice } from "../CloudWorkspaceRegionChoice";
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
const fetchMock = jest.fn();
const options = {
  status: "selection_required",
  token: "a".repeat(64),
  choices: [
    { id: "us-one", region: "us-east-1", lastStartedAt: null },
    {
      id: "us-two",
      region: "us-east-1",
      lastStartedAt: "2026-10-30T12:00:00Z",
    },
    { id: "eu-one", region: "eu-central-1", lastStartedAt: null },
  ],
};
const response = (body: unknown) => ({ ok: true, json: async () => body });
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock;
});

it("explains retained unavailable workspaces without selecting or starting anything", async () => {
  fetchMock.mockResolvedValue(response({ ...options, unavailableCount: 2 }));
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  expect(
    await screen.findByText(/Some saved workspaces cannot be selected here/),
  ).toHaveTextContent(/files will be kept unchanged/);
  expect(
    screen
      .getAllByRole("radio")
      .every((radio) => !(radio as HTMLInputElement).checked),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Use this workspace" }),
  ).toBeDisabled();
  expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(retry).not.toHaveBeenCalled();
});

it("resumes a due status check after returning to a hidden tab without replaying work", async () => {
  jest.useFakeTimers();
  const visibility = jest
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const retry = jest.fn();
  try {
    fetchMock
      .mockResolvedValueOnce(
        response({ status: "waiting", reason: "active_tasks" }),
      )
      .mockResolvedValueOnce(
        response({ status: "selected", id: "us-one", region: "us-east-1" }),
      );
    render(<CloudWorkspaceRegionChoice onRetry={retry} />);
    await screen.findByText(/A task is still running/);
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await screen.findByRole("button", { name: "Retry" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
    expect(retry).not.toHaveBeenCalled();
  } finally {
    visibility.mockRestore();
    jest.useRealTimers();
  }
});

it("shows background check progress without losing focus or starting an overlapping read", async () => {
  jest.useFakeTimers();
  let finish!: (value: ReturnType<typeof response>) => void;
  try {
    fetchMock
      .mockResolvedValueOnce(
        response({ status: "waiting", reason: "recent_activity" }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    render(<CloudWorkspaceRegionChoice manage />);
    const button = await screen.findByRole("button", { name: "Check status" });
    button.focus();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(button).toHaveTextContent("Checking status…");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish(response({ status: "waiting", reason: "recent_activity" }));
    });
    expect(
      await screen.findByRole("button", { name: "Check status" }),
    ).toHaveFocus();
    expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

it("lets an owner choose a particular same-region copy without starting work from the manager", async () => {
  fetchMock
    .mockResolvedValueOnce(response({ ...options, currentId: "us-one" }))
    .mockResolvedValueOnce(
      response({ status: "selected", region: "us-east-1", id: "us-two" }),
    );
  render(<CloudWorkspaceRegionChoice manage />);
  expect(
    await screen.findAllByRole("radio", { name: /US workspace/ }),
  ).toHaveLength(2);
  expect(
    screen.getByRole("button", { name: "Use this workspace" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /ID us-two/ }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Use this workspace" }));
  await screen.findByText(/Future cloud tasks will use this workspace/);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    workspaceId: "us-two",
    token: options.token,
  });
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});

it("shows the manual fallback only after the final automatic read settles and stops polling", async () => {
  jest.useFakeTimers();
  let finish!: (value: ReturnType<typeof response>) => void;
  const waiting = { status: "waiting", reason: "recent_activity" };
  try {
    fetchMock.mockImplementation(() =>
      fetchMock.mock.calls.length === 31
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(response({ ...waiting })),
    );
    render(<CloudWorkspaceRegionChoice manage />);
    await screen.findByRole("button", { name: "Check status" });
    for (let check = 0; check < 30; check++) {
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
    }
    expect(
      screen.getByRole("button", { name: "Checking status…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByText(/Use Check status to check again/),
    ).not.toBeInTheDocument();
    await act(async () => {
      finish(response(waiting));
    });
    expect(screen.getByText(/Use Check status to check again/)).toBeVisible();
    await act(async () => {
      jest.advanceTimersByTime(90_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(31);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    });
    await waitFor(() =>
      expect(
        screen.queryByText(/Use Check status to check again/),
      ).not.toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

it("refreshes a stale inline card after a choice is saved elsewhere without retrying the task", async () => {
  fetchMock
    .mockResolvedValueOnce(response(options))
    .mockResolvedValueOnce(
      response({ status: "selected", region: "us-east-1", id: "us-two" }),
    );
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  await screen.findByRole("button", { name: "Use this workspace" });
  await act(async () => {
    window.dispatchEvent(new Event("hackerai:cloud-workspace-selected"));
  });
  await screen.findByRole("button", { name: "Retry" });
  expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(retry).not.toHaveBeenCalled();
});

it("keeps the requested chooser open through waiting and only rechecks status", async () => {
  fetchMock
    .mockResolvedValueOnce(
      response({ status: "selected", region: "us-east-1", id: "us-one" }),
    )
    .mockResolvedValueOnce(
      response({ status: "waiting", reason: "recent_activity" }),
    )
    .mockResolvedValueOnce(response({ ...options, currentId: "us-one" }));
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose another workspace" }),
  );
  await screen.findByText(/15 minutes without workspace activity/);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await screen.findByRole("button", { name: "Use this workspace" });
  expect(fetchMock.mock.calls[2][0]).toBe("/api/sandbox/workspaces?manage=1");
  expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(retry).not.toHaveBeenCalled();
});

it("reconciles a selection saved elsewhere during a pending status read", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  fetchMock
    .mockResolvedValueOnce(
      response({ status: "waiting", reason: "recent_activity" }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(
      response({ status: "selected", id: "eu-one", region: "eu-central-1" }),
    );
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
  await act(async () => {
    window.dispatchEvent(new Event("hackerai:cloud-workspace-selected"));
    window.dispatchEvent(new Event("hackerai:cloud-workspace-selected"));
    finish(response({ status: "waiting", reason: "recent_activity" }));
  });
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Using your Europe workspace",
  );
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(retry).not.toHaveBeenCalled();
});

it("lets the owner keep the current workspace and regain Retry while switching is waiting", async () => {
  const selected = { status: "selected", id: "us-one", region: "us-east-1" };
  fetchMock
    .mockResolvedValueOnce(response(selected))
    .mockResolvedValueOnce(
      response({ status: "waiting", reason: "recent_activity" }),
    )
    .mockResolvedValueOnce(response(selected));
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose another workspace" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Keep current workspace" }),
  );
  expect(await screen.findByRole("button", { name: "Retry" })).toHaveFocus();
  expect(fetchMock.mock.calls[2][0]).toBe("/api/sandbox/workspaces");
  expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(retry).not.toHaveBeenCalled();
});

it("announces available choices and keeps keyboard focus in the card when a wait ends", async () => {
  jest.useFakeTimers();
  try {
    fetchMock
      .mockResolvedValueOnce(
        response({ status: "waiting", reason: "active_tasks" }),
      )
      .mockResolvedValueOnce(response(options));
    render(<CloudWorkspaceRegionChoice onRetry={jest.fn()} />);
    (await screen.findByRole("button", { name: "Check status" })).focus();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(
      await screen.findByRole("group", { name: "Choose your cloud workspace" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workspace choices are ready.",
    );
  } finally {
    jest.useRealTimers();
  }
});
it("requires an explicit choice and explicit retry after saving", async () => {
  fetchMock
    .mockResolvedValueOnce(response(options))
    .mockResolvedValueOnce(
      response({ status: "selected", region: "eu-central-1", id: "eu-one" }),
    );
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  fireEvent.click(
    await screen.findByRole("radio", { name: /Europe workspace/ }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Use this workspace" }));
  const button = await screen.findByRole("button", { name: "Retry" });
  expect(retry).not.toHaveBeenCalled();
  expect(button).toHaveFocus();
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    workspaceId: "eu-one",
    token: options.token,
  });
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
});
it("reconciles a lost POST response using a read and shows the actual saved choice", async () => {
  fetchMock
    .mockResolvedValueOnce(response(options))
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValueOnce(
      response({ status: "selected", region: "us-east-1", id: "us-one" }),
    );
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  fireEvent.click(
    await screen.findByRole("radio", { name: /Europe workspace/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use this workspace" }));
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByRole("alert")).toHaveTextContent("different workspace");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Using your US workspace",
  );
  expect(
    fetchMock.mock.calls.filter(([, o]) => o.method === "POST"),
  ).toHaveLength(1);
  expect(retry).not.toHaveBeenCalled();
});
it("blocks retries and duplicate writes while a response is pending or uncertain", async () => {
  let reject!: (reason: Error) => void;
  fetchMock
    .mockResolvedValueOnce(response(options))
    .mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  render(<CloudWorkspaceRegionChoice onRetry={jest.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: /ID us-one/ }));
  const button = screen.getByRole("button", { name: "Use this workspace" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(
    fetchMock.mock.calls.filter(([, o]) => o.method === "POST"),
  ).toHaveLength(1);
  reject(new Error("timeout"));
  await screen.findByRole("button", { name: "Check status" });
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(
    fetchMock.mock.calls.filter(([, o]) => o.method === "POST"),
  ).toHaveLength(1);
});
it("checks saved routing after reload without making another choice", async () => {
  fetchMock.mockResolvedValue(
    response({ status: "selected", region: "eu-central-1", id: "eu-one" }),
  );
  const retry = jest.fn();
  const { unmount } = render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  await screen.findByRole("button", { name: "Retry" });
  unmount();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.every(([, o]) => !o.method)).toBe(true);
  expect(retry).not.toHaveBeenCalled();
});

it("does not steal composer focus when a background status read finds a saved choice", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <>
      <input aria-label="Message" />
      <CloudWorkspaceRegionChoice onRetry={jest.fn()} />
    </>,
  );
  const composer = screen.getByRole("textbox", { name: "Message" });
  composer.focus();
  finish(
    response({ status: "selected", region: "eu-central-1", id: "eu-one" }),
  );
  await screen.findByRole("button", { name: "Retry" });
  expect(composer).toHaveFocus();
});

it("offers same-workspace recovery directly in management without automatically confirming", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    response(
      url.includes("/recovery")
        ? { status: "offered", token: "7ad19af5-4d14-4d4b-aab7-90734610a6da" }
        : { status: "protected", reason: "recovery" },
    ),
  );
  render(<CloudWorkspaceRegionChoice manage />);
  expect(
    await screen.findByRole("button", { name: "Recover workspace" }),
  ).toBeEnabled();
  expect(
    screen.getByText(/same workspace in its current region/),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Check status" })).toHaveLength(
    1,
  );
  expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method)).toBe(true);
});

it.each(["hidden", "recovered"])(
  "refreshes protected workspace options after a %s recovery status without replaying a task",
  async (status) => {
    let settled = false;
    const retry = jest.fn();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/recovery")) {
        settled = true;
        return response({ status });
      }
      return response(
        settled ? options : { status: "protected", reason: "recovery" },
      );
    });
    render(<CloudWorkspaceRegionChoice manage onRetry={retry} />);
    expect(await screen.findAllByRole("radio")).toHaveLength(3);
    expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method)).toBe(true);
    expect(retry).not.toHaveBeenCalled();
  },
);

it("queues a recovery settlement behind an older options read and preserves management choices", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  let optionReads = 0;
  let recoveryReads = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/recovery"))
      return response({
        status: ++recoveryReads === 1 ? "hidden" : "recovered",
      });
    expect(url).toContain("?manage=1");
    optionReads++;
    if (optionReads === 2)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return response(
      optionReads === 1 ? { status: "protected", reason: "recovery" } : options,
    );
  });
  render(<CloudWorkspaceRegionChoice manage />);
  await waitFor(() => expect(optionReads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(() => expect(recoveryReads).toBe(2));
  await act(async () => {
    finish(response({ status: "protected", reason: "recovery" }));
  });
  expect(await screen.findAllByRole("radio")).toHaveLength(3);
  expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method)).toBe(true);
});
