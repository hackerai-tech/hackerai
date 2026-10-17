import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CloudNetworkSettings } from "../CloudNetworkSettings";
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
  global.fetch = fetchMock;
  fetchMock.mockResolvedValue(response(saved));
});
it("loads and edits the workspace allowlist and only reports applied after server verification", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  fireEvent.change(field, {
    target: { value: "api.example.test\n*.another.test" },
  });
  fetchMock.mockResolvedValueOnce(response({ ...saved, revision: 3 }));
  fireEvent.click(
    screen.getByRole("button", { name: "Apply network settings" }),
  );
  await screen.findByText(/Applied to running cloud workspaces/);
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
  fireEvent.click(
    screen.getByRole("button", { name: "Apply network settings" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be verified",
  );
  expect(
    screen.getByRole("button", { name: "Apply network settings" }),
  ).toBeDisabled();
  fetchMock.mockResolvedValueOnce(
    response({ ...saved, revision: 3, status: "failed" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Apply network settings" }),
    ).toBeEnabled(),
  );
  expect(screen.queryByText(/Applied to running/)).not.toBeInTheDocument();
});

it("shows readable network validation without submitting invalid input", async () => {
  render(<CloudNetworkSettings />);
  const field = await screen.findByLabelText("Allowed destinations");
  fireEvent.change(field, { target: { value: "bad host" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Apply network settings" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Use a valid hostname",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
