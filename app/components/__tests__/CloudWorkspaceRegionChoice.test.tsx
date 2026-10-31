import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloudWorkspaceRegionChoice } from "../CloudWorkspaceRegionChoice";
const fetchMock = jest.fn();
const options = {
  status: "selection_required",
  token: "a".repeat(64),
  choices: ["us-east-1", "eu-central-1"],
};
const response = (body: unknown) => ({ ok: true, json: async () => body });
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock;
});
it("requires an explicit choice and explicit retry after saving", async () => {
  fetchMock
    .mockResolvedValueOnce(response(options))
    .mockResolvedValueOnce(
      response({ status: "selected", region: "eu-central-1" }),
    );
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Europe workspace" }),
  );
  const button = await screen.findByRole("button", { name: "Retry" });
  expect(retry).not.toHaveBeenCalled();
  expect(button).toHaveFocus();
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    region: "eu-central-1",
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
      response({ status: "selected", region: "us-east-1" }),
    );
  const retry = jest.fn();
  render(<CloudWorkspaceRegionChoice onRetry={retry} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Europe workspace" }),
  );
  await screen.findByRole("button", { name: "Retry" });
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
  const button = await screen.findByRole("button", { name: "US workspace" });
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
    response({ status: "selected", region: "eu-central-1" }),
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
