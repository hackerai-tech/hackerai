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
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
  await screen.findByLabelText("Allowed destinations");
  fetchMock.mockResolvedValueOnce(
    response({ error: "Update could not be verified" }, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be verified",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fetchMock.mockResolvedValueOnce(
    response({ ...saved, revision: 3, status: "failed" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it("shows readable network validation without submitting invalid input", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  fireEvent.change(field, { target: { value: "bad host" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Use a valid hostname",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Reload settings" }),
  ).not.toBeInTheDocument();
});

it("refreshes a running update and uses its completed revision on the next save", async () => {
  jest.useFakeTimers();
  fetchMock.mockResolvedValueOnce(response({ ...saved, status: "applying" }));
  render(<CloudNetworkSettings />);
  expect(await screen.findByLabelText("Allowed destinations")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
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
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fetchMock.mockResolvedValueOnce(response({ ...saved, status: "applying" }));
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "update is in progress",
    ),
  );
  await act(() => jest.advanceTimersByTimeAsync(3_000));
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
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
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Reload settings" })).toBeEnabled();
  const completedReads = fetchMock.mock.calls.length;
  await act(() => jest.advanceTimersByTimeAsync(6_000));
  expect(fetchMock).toHaveBeenCalledTimes(completedReads);
});

it("requires reload after losing a save response before retrying", async () => {
  render(<CloudNetworkSettings />);
  await screen.findByLabelText("Allowed destinations");
  fetchMock.mockRejectedValueOnce(new Error("Disconnected"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fetchMock.mockResolvedValueOnce(response({ ...saved, revision: 4 }));
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
