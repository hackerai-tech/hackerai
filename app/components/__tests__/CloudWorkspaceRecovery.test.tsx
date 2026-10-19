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
it("renders informed consent without submitting or replaying a task", async () => {
  fetchMock.mockResolvedValue(respond({ status: "offered", token }));
  render(<CloudWorkspaceRecovery />);
  expect(
    await screen.findByText(
      /Running processes and unsaved changes may be lost/,
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
    .mockResolvedValue(respond({ status: "declined" }));
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
