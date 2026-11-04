import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  CloudRecoveryAdmissionContext,
  useCloudRecoveryAdmission,
} from "@/app/hooks/useCloudRecoveryAdmission";
import { CloudWorkspaceRecovery } from "../CloudWorkspaceRecovery";

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
const token = "7ad19af5-4d14-4d4b-aab7-90734610a6da";
const fetchMock = jest.fn();
const response = (status: string) => ({
  ok: true,
  json: async () => ({ status, token }),
});
function Harness({ panelKey = "a", cloud = true, second = false }) {
  const admission = useCloudRecoveryAdmission();
  return (
    <CloudRecoveryAdmissionContext.Provider value={admission}>
      <output data-testid="gate">
        {cloud && admission.sendDisabledReason}
      </output>
      <CloudWorkspaceRecovery key={panelKey} surface="workspace_status" />
      {second && <CloudWorkspaceRecovery surface="workspace_dialog" />}
    </CloudRecoveryAdmissionContext.Provider>
  );
}
beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = fetchMock;
  fetchMock.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

it.each(["offered", "declined", "waiting", "recovered", "hidden", "support"])(
  "does not lock a healthy Cloud composer for %s",
  async (status) => {
    fetchMock.mockResolvedValue(response(status));
    render(<Harness />);
    await act(async () => {});
    expect(screen.getByTestId("gate")).toBeEmptyDOMElement();
  },
);

it("holds an uncertain confirmation through failed status reads without repeating consent", async () => {
  let rejectPost!: (error: Error) => void;
  fetchMock
    .mockResolvedValueOnce(response("offered"))
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPost = reject;
        }),
    )
    .mockRejectedValue(new Error("offline"));
  render(<Harness />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Recover workspace" }));
  expect(screen.getByTestId("gate")).toHaveTextContent(
    "Starting Cloud workspace recovery",
  );
  await act(async () => {
    rejectPost(new Error("response lost"));
  });
  await act(async () => jest.advanceTimersByTimeAsync(15000));
  expect(screen.getByTestId("gate")).toHaveTextContent(
    "recovery is in progress",
  );
  expect(
    fetchMock.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(1);
  fetchMock.mockResolvedValue(response("recovered"));
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await act(async () => {});
  expect(screen.getByTestId("gate")).toBeEmptyDOMElement();
});

it("ignores the other panel's stale clear read and retains the block across chat remounts", async () => {
  let finishOld!: (value: ReturnType<typeof response>) => void;
  let finishNew!: (value: ReturnType<typeof response>) => void;
  fetchMock
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(response("recovering"));
  const { rerender } = render(<Harness second />);
  await act(async () => {});
  expect(screen.getByTestId("gate")).toHaveTextContent(
    "recovery is in progress",
  );
  await act(async () => finishOld(response("hidden")));
  expect(screen.getByTestId("gate")).toHaveTextContent(
    "recovery is in progress",
  );
  fetchMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishNew = resolve;
      }),
  );
  rerender(<Harness panelKey="another-chat" cloud={false} second />);
  expect(screen.getByTestId("gate")).toBeEmptyDOMElement();
  rerender(<Harness panelKey="another-chat" cloud second />);
  expect(screen.getByTestId("gate")).toHaveTextContent(
    "recovery is in progress",
  );
  await act(async () => finishNew(response("recovered")));
  expect(screen.getByTestId("gate")).toBeEmptyDOMElement();
});

it("does not turn a failed initial status lookup into an indefinite outage", async () => {
  fetchMock.mockRejectedValue(new Error("status unavailable"));
  render(<Harness />);
  expect(screen.getByTestId("gate")).toHaveTextContent(
    "Checking Cloud workspace status",
  );
  await act(async () => {});
  expect(screen.getByTestId("gate")).toBeEmptyDOMElement();
});

it("rechecks another tab's recovery change without submitting consent", async () => {
  const original = global.BroadcastChannel;
  let receive: ((event: { data: string }) => void) | null = null;
  const close = jest.fn();
  global.BroadcastChannel = jest.fn(() => ({
    set onmessage(handler: typeof receive) {
      receive = handler;
    },
    postMessage: jest.fn(),
    close,
  })) as unknown as typeof BroadcastChannel;
  try {
    fetchMock
      .mockResolvedValueOnce(response("hidden"))
      .mockResolvedValue(response("recovering"));
    const { unmount } = render(<Harness />);
    await act(async () => {});
    expect(screen.getByTestId("gate")).toBeEmptyDOMElement();
    await act(async () => {
      receive?.({ data: "changed" });
    });
    expect(screen.getByTestId("gate")).toHaveTextContent(
      "recovery is in progress",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(
      true,
    );
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    global.BroadcastChannel = original;
  }
});
