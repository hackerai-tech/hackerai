import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CloudWorkspaceRecovery } from "../CloudWorkspaceRecovery";
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
const token = "7ad19af5-4d14-4d4b-aab7-90734610a6da";
const fetchMock = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock;
});
const respond = (body: unknown) => ({ ok: true, json: async () => body });
it("ignores an older status read after this tab submits consent", async () => {
  jest.useFakeTimers();
  try {
    let finishRead!: (response: ReturnType<typeof respond>) => void;
    fetchMock
      .mockResolvedValueOnce(respond({ status: "offered", token }))
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishRead = resolve)),
      )
      .mockResolvedValueOnce(
        respond({ status: "recovering", step: "backup_created" }),
      );
    render(<CloudWorkspaceRecovery />);
    const confirm = await screen.findByRole("button", {
      name: "Recover workspace",
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    fireEvent.click(confirm);
    await screen.findByText(/Saving the recovered environment/);
    await act(async () => {
      finishRead(respond({ status: "offered", token }));
    });
    expect(screen.getByText(/Saving the recovered environment/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Recover workspace" }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
    ).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

it.each(["poll", "decision"])(
  "ignores an older manual status response after a newer %s",
  async (source) => {
    jest.useFakeTimers();
    try {
      let finishManual!: (response: ReturnType<typeof respond>) => void;
      fetchMock
        .mockResolvedValueOnce(respond({ status: "offered", token }))
        .mockRejectedValueOnce(new Error("network"))
        .mockImplementationOnce(
          () => new Promise((resolve) => (finishManual = resolve)),
        )
        .mockResolvedValueOnce(
          respond(
            source === "poll"
              ? { status: "recovered" }
              : { status: "recovering", step: "backup_created" },
          ),
        );
      render(<CloudWorkspaceRecovery />);
      await screen.findByRole("button", { name: "Recover workspace" });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Check status" }),
      );
      if (source === "poll") {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(5000);
        });
      } else {
        fireEvent.click(
          screen.getByRole("button", { name: "Recover workspace" }),
        );
      }
      const expected =
        source === "poll"
          ? /Workspace ready/
          : /Saving the recovered environment/;
      await screen.findByText(expected);
      await act(async () => {
        finishManual(respond({ status: "offered", token }));
      });
      expect(screen.getByText(expected)).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Recover workspace" }),
      ).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  },
);

it.each(["offered", "declined"])(
  "reconciles a %s tab when another tab confirms recovery, without submitting consent",
  async (status) => {
    jest.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(respond({ status, token }))
        .mockResolvedValueOnce(
          respond({ status: "recovering", step: "backup_created" }),
        )
        .mockResolvedValue(respond({ status: "recovered" }));
      render(<CloudWorkspaceRecovery surface="workspace_status" />);
      await screen.findByRole("button", {
        name: status === "offered" ? "Recover workspace" : "Review recovery",
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(
        screen.getByText(/Saving the recovered environment/),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Recover workspace" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText(/Workspace ready/)).toBeVisible();
      const settledReads = fetchMock.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(settledReads);
      expect(
        fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
      ).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  },
);

it("renders informed consent without submitting or replaying a task", async () => {
  fetchMock.mockResolvedValue(respond({ status: "offered", token }));
  render(<CloudWorkspaceRecovery />);
  expect(
    await screen.findByText(
      /A restart stops running processes and discards changes/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Recover workspace" }),
  ).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("submits explicit consent once, then renders progress and verified completion", async () => {
  jest.useFakeTimers();
  fetchMock
    .mockResolvedValueOnce(respond({ status: "offered", token }))
    .mockResolvedValueOnce(
      respond({ status: "recovering", step: "backup_created" }),
    )
    .mockResolvedValueOnce(respond({ status: "recovered" }));
  render(<CloudWorkspaceRecovery />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Recover workspace" }),
  );
  await waitFor(() =>
    expect(
      screen.getByText(/Saving the recovered environment/),
    ).toBeInTheDocument(),
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    token,
    confirmed: true,
  });
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(
    await screen.findByText(/Previous tasks will not restart automatically/),
  ).toBeInTheDocument();
  expect(
    fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
  ).toHaveLength(1);
  jest.useRealTimers();
});
it("declines explicitly and does not show a second confirmation", async () => {
  fetchMock
    .mockResolvedValueOnce(respond({ status: "offered", token }))
    .mockResolvedValue(respond({ status: "declined", token }));
  render(<CloudWorkspaceRecovery />);
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Recover workspace" }),
    ).not.toBeInTheDocument(),
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    token,
    confirmed: false,
  });
});
it("uses status reads after a lost confirmation response", async () => {
  fetchMock
    .mockResolvedValueOnce(respond({ status: "offered", token }))
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValue(respond({ status: "support" }));
  render(<CloudWorkspaceRecovery />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Recover workspace" }),
  );
  expect(
    await screen.findByText(/needs support to recover safely/),
  ).toBeInTheDocument();
  expect(
    fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
  ).toHaveLength(1);
});
it("refreshing during recovery displays progress without offering another reboot", async () => {
  fetchMock.mockResolvedValue(
    respond({ status: "recovering", step: "normal_resume_verified" }),
  );
  render(<CloudWorkspaceRecovery />);
  expect(await screen.findByText(/Finishing verification/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Recover workspace" }),
  ).not.toBeInTheDocument();
});

it("reopens a deferred recovery after reload without confirming it", async () => {
  fetchMock
    .mockResolvedValueOnce(respond({ status: "declined", token }))
    .mockResolvedValueOnce(respond({ status: "offered", token }));
  render(<CloudWorkspaceRecovery surface="workspace_status" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review recovery" }),
  );
  expect(
    await screen.findByRole("button", { name: "Recover workspace" }),
  ).toBeEnabled();
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    token,
    reopen: true,
  });
});
it("offers actionable support and a reference without transmitting customer content", async () => {
  const intercom = jest.fn();
  Object.defineProperty(window, "Intercom", {
    configurable: true,
    value: intercom,
  });
  fetchMock.mockResolvedValue(
    respond({ status: "support", reference: "CR-example" }),
  );
  render(<CloudWorkspaceRecovery />);
  expect(await screen.findByText("Reference: CR-example")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Help center" })).toHaveAttribute(
    "href",
    "https://help.hackerai.co/",
  );
  fireEvent.click(screen.getByRole("button", { name: "Contact support" }));
  await waitFor(() =>
    expect(intercom).toHaveBeenCalledWith(
      "showNewMessage",
      expect.stringContaining("CR-example"),
    ),
  );
  expect(
    fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
  ).toHaveLength(0);
  delete (window as Window & { Intercom?: unknown }).Intercom;
});

it("finds a delayed failure record after the timed-out stream has already closed", async () => {
  jest.useFakeTimers();
  try {
    fetchMock
      .mockResolvedValueOnce(respond({ status: "hidden" }))
      .mockResolvedValueOnce(respond({ status: "hidden" }))
      .mockResolvedValue(respond({ status: "offered", token }));
    render(<CloudWorkspaceRecovery surface="cloud_connection_error" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15000);
    });
    expect(
      screen.getByRole("button", { name: "Recover workspace" }),
    ).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
    ).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});

it("bounds status retries when the event never produces a recoverable record", async () => {
  jest.useFakeTimers();
  try {
    fetchMock.mockResolvedValue(respond({ status: "hidden" }));
    render(<CloudWorkspaceRecovery surface="cloud_connection_error" />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(180000);
    });
    const settledReads = fetchMock.mock.calls.length;
    expect(settledReads).toBeGreaterThan(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(settledReads);
    expect(
      fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
    ).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
it("does not poll a healthy hidden workspace banner without a cloud failure event", async () => {
  jest.useFakeTimers();
  try {
    fetchMock.mockResolvedValue(respond({ status: "hidden" }));
    render(<CloudWorkspaceRecovery surface="workspace_status" />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(180000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("keeps a manual status check after failed background reads exhaust their window", async () => {
  jest.useFakeTimers();
  try {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<CloudWorkspaceRecovery surface="cloud_connection_error" />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(180000);
    });
    const check = screen.getByRole("button", { name: "Check status" });
    expect(check).toBeEnabled();
    fetchMock.mockResolvedValue(respond({ status: "offered", token }));
    fireEvent.click(check);
    expect(
      await screen.findByRole("button", { name: "Recover workspace" }),
    ).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST"),
    ).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
