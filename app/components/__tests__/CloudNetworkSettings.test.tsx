import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { CloudNetworkSettings } from "../CloudNetworkSettings";
import { toast } from "sonner";
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }));
const capture = jest.fn();
// Stable provider identity prevents an unrelated provider replacement from remounting the effect.
const posthog = { capture };
jest.mock("posthog-js/react", () => ({ usePostHog: () => posthog }));
const fetchMock = jest.fn();
const saved = {
  policy: { mode: "restricted", allow: ["api.example.test"] },
  revision: 2,
  status: "ready",
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  global.fetch = fetchMock;
  fetchMock.mockResolvedValue(response(saved));
});
afterEach(() => jest.useRealTimers());
it("loads and edits the workspace allowlist and only reports applied after server verification", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  expect(
    screen.queryByRole("button", { name: "Reload settings" }),
  ).not.toBeInTheDocument();
  fireEvent.change(field, {
    target: { value: "api.example.test\n*.another.test" },
  });
  let finishSave!: (value: ReturnType<typeof response>) => void;
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      finishSave = resolve;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(toast.success).not.toHaveBeenCalled();
  finishSave(response({ ...saved, revision: 3 }));
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith("Network settings updated."),
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    expectedRevision: 2,
    policy: {
      mode: "restricted",
      allow: ["*.another.test", "api.example.test"],
    },
  });
});
it("retains a failed save message and requires a fresh revision before retry", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  fireEvent.change(field, { target: { value: "changed.example.test" } });
  fetchMock.mockResolvedValueOnce(
    response({ error: "Update could not be verified" }, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be verified",
  );
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fetchMock.mockResolvedValueOnce(
    response({ ...saved, revision: 3, status: "failed" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled(),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it("shows readable network validation without submitting invalid input", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  fireEvent.change(field, { target: { value: "bad host" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Use a valid hostname",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Reload settings" }),
  ).not.toBeInTheDocument();
});

it("refreshes a running update and uses its completed revision on the next save", async () => {
  jest.useFakeTimers();
  fetchMock.mockResolvedValueOnce(response({ ...saved, status: "applying" }));
  render(<CloudNetworkSettings />);
  expect(await screen.findByLabelText("Allowed destinations")).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Reload settings" }),
  ).not.toBeInTheDocument();
  fetchMock.mockResolvedValueOnce(response({ ...saved, revision: 3 }));
  await act(() => jest.advanceTimersByTimeAsync(3_000));
  expect(screen.getByLabelText("Allowed destinations")).toBeEnabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  const completedReads = fetchMock.mock.calls.length;
  await act(() => jest.advanceTimersByTimeAsync(6_000));
  expect(fetchMock).toHaveBeenCalledTimes(completedReads);
  fireEvent.change(screen.getByLabelText("Allowed destinations"), {
    target: { value: "changed.example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).expectedRevision).toBe(
    3,
  );
});

it("shows recovery after a failed status refresh and resumes polling after reload", async () => {
  jest.useFakeTimers();
  fetchMock.mockResolvedValueOnce(response({ ...saved, status: "applying" }));
  render(<CloudNetworkSettings />);
  await screen.findByLabelText("Allowed destinations");
  fetchMock.mockRejectedValueOnce(new Error("Disconnected"));
  await act(() => jest.advanceTimersByTimeAsync(3_000));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh");
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fetchMock.mockResolvedValueOnce(response({ ...saved, status: "applying" }));
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "update is in progress",
    ),
  );
  await act(() => jest.advanceTimersByTimeAsync(3_000));
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Reload settings" }),
  ).not.toBeInTheDocument();
});

it("stops refreshing an abandoned update and offers a manual retry", async () => {
  jest.useFakeTimers();
  fetchMock.mockResolvedValue(response({ ...saved, status: "applying" }));
  render(<CloudNetworkSettings />);
  await screen.findByLabelText("Allowed destinations");
  await act(() => jest.advanceTimersByTimeAsync(120_000));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "taking longer than expected",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Reload settings" })).toBeEnabled();
  const completedReads = fetchMock.mock.calls.length;
  await act(() => jest.advanceTimersByTimeAsync(6_000));
  expect(fetchMock).toHaveBeenCalledTimes(completedReads);
});

it("requires reload after losing a save response before retrying", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  fireEvent.change(field, { target: { value: "changed.example.test" } });
  fetchMock.mockRejectedValueOnce(new Error("Disconnected"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fetchMock.mockResolvedValueOnce(response({ ...saved, revision: 4 }));
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Allowed destinations")).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fireEvent.change(field, { target: { value: "changed.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).expectedRevision).toBe(
    4,
  );
});

it("cancels a pending refresh when the settings panel closes", async () => {
  jest.useFakeTimers();
  fetchMock.mockResolvedValueOnce(response({ ...saved, status: "applying" }));
  const { unmount } = render(<CloudNetworkSettings />);
  await screen.findByLabelText("Allowed destinations");
  fetchMock.mockReturnValueOnce(new Promise(() => {}));
  await act(() => jest.advanceTimersByTimeAsync(3_000));
  const signal = fetchMock.mock.calls.at(-1)[1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  const completedReads = fetchMock.mock.calls.length;
  await act(() => jest.advanceTimersByTimeAsync(120_000));
  expect(fetchMock).toHaveBeenCalledTimes(completedReads);
});

it("hides Save changes until the effective policy changes and hides it on revert", async () => {
  fetchMock.mockResolvedValueOnce(
    response({
      ...saved,
      policy: {
        mode: "restricted",
        allow: ["api.example.test", "other.example.test"],
      },
    }),
  );
  render(<CloudNetworkSettings />);
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  const field = await screen.findByLabelText("Allowed destinations");
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fireEvent.change(field, {
    target: {
      value: " OTHER.example.test  \napi.example.test\napi.example.test\n\n",
    },
  });
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fireEvent.change(field, { target: { value: "new.example.test" } });
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  fireEvent.change(field, {
    target: { value: "api.example.test\nother.example.test" },
  });
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("can retry an unchanged failed policy and hides Retry after success", async () => {
  fetchMock.mockResolvedValueOnce(response({ ...saved, status: "failed" }));
  render(<CloudNetworkSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    policy: saved.policy,
    expectedRevision: 2,
  });
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
});

it("disables saving an empty restricted policy and clears validation when corrected", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  fireEvent.change(field, { target: { value: "   " } });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Add an allowed destination",
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  fireEvent.change(field, { target: { value: "valid.example.test" } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

it("requires Save changes for mode switches and hides it when the mode is reverted", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  fetchMock.mockResolvedValueOnce(
    response({ ...saved, policy: { mode: "unrestricted", allow: [] } }),
  );
  render(<CloudNetworkSettings />);
  const select = screen.getByRole("combobox", { name: "Access" });
  await waitFor(() => expect(select).toBeEnabled());
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(select, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: "No internet" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(select, { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("option", { name: "Internet access", exact: true }),
  );
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(select, { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("option", { name: "Allowed destinations only" }),
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Allowed destinations"), {
    target: { value: "api.example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
});
