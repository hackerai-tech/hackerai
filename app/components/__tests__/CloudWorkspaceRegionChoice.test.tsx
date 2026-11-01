import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("refreshes a stale inline card after a choice is saved elsewhere without retrying the task", async () => {
  fetchMock
    .mockResolvedValueOnce(response(options))
    .mockResolvedValueOnce(
      response({ status: "selected", region: "us-east-1", id: "us-two" }),
    );
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  await screen.findByRole("button", { name: "Use this workspace" });
  window.dispatchEvent(new Event("hackerai:cloud-workspace-selected"));
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
