import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { randomUUID } from "node:crypto";
import ReportForm from "../ReportForm";

type Callbacks = {
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};
const widgets: Callbacks[] = [];
const widgetApi = {
  render: jest.fn((_node: HTMLElement, callbacks: Callbacks) => {
    widgets.push(callbacks);
    return `widget-${widgets.length}`;
  }),
  remove: jest.fn(),
};
const windowWithWidget = window as Window & { turnstile?: typeof widgetApi };
const originalFetch = global.fetch;
const originalObserver = global.ResizeObserver;
const originalUUID = crypto.randomUUID;
const submit = () =>
  fireEvent.click(
    screen.getByRole("button", { name: /^(Submit report|Try again)$/ }),
  );
function fill() {
  fireEvent.change(screen.getByLabelText("Contact email"), {
    target: { value: "reporter@example.test" },
  });
  fireEvent.change(
    screen.getByLabelText("Affected domain, IP address, or system"),
    { target: { value: "example.test" } },
  );
  fireEvent.change(screen.getByLabelText("What happened?"), {
    target: { value: "Synthetic observation for a retry regression test." },
  });
}
function verified(token = "first-challenge") {
  act(() => widgets.at(-1)!.callback(token));
}

beforeEach(() => {
  widgets.length = 0;
  windowWithWidget.turnstile = widgetApi;
  global.fetch = jest.fn();
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  crypto.randomUUID = randomUUID;
  jest
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: 350 } as DOMRect);
});
afterEach(() => {
  cleanup();
  delete windowWithWidget.turnstile;
  global.fetch = originalFetch;
  global.ResizeObserver = originalObserver;
  crypto.randomUUID = originalUUID;
  jest.restoreAllMocks();
});

test("a lost response retains fields and retries the same submission with a new challenge", async () => {
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockRejectedValueOnce(new Error("response lost"));
  fetchMock.mockImplementationOnce(async (_url, init) => ({
    ok: true,
    json: async () => ({
      received: true,
      reference: `AB-${JSON.parse(init.body).submissionId}`,
    }),
  }));
  render(<ReportForm available siteKey="synthetic-site-key" />);
  fill();
  verified();
  submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not confirm",
  );
  expect(screen.getByLabelText("Contact email")).toHaveValue(
    "reporter@example.test",
  );
  expect(screen.getByLabelText("What happened?")).toHaveValue(
    "Synthetic observation for a retry regression test.",
  );
  expect(
    screen.queryByRole("heading", { name: "Your report is saved" }),
  ).not.toBeInTheDocument();
  submit();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(document.getElementById("security-check")).toHaveFocus();
  verified("renewed-challenge");
  submit();
  expect(
    await screen.findByRole("heading", { name: "Your report is saved" }),
  ).toHaveFocus();
  const first = fetchMock.mock.calls[0][1],
    retry = fetchMock.mock.calls[1][1];
  expect(retry.body).toBe(first.body);
  expect([
    first.headers["X-Turnstile-Token"],
    retry.headers["X-Turnstile-Token"],
  ]).toEqual(["first-challenge", "renewed-challenge"]);
  expect(retry.body).not.toContain("challenge");
});

test("slow composition and expired callbacks require renewal without discarding the report", async () => {
  let now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  render(<ReportForm available siteKey="synthetic-site-key" />);
  fill();
  verified();
  now += 300_001;
  submit();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Complete the security check",
  );
  expect(widgets).toHaveLength(2);
  verified("fresh-challenge");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  act(() => widgets.at(-1)!["expired-callback"]());
  submit();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("What happened?")).toHaveValue(
    "Synthetic observation for a retry regression test.",
  );
});

test("a blocked script can be retried in place without losing entered fields", async () => {
  delete windowWithWidget.turnstile;
  render(<ReportForm available siteKey="synthetic-site-key" />);
  fill();
  const firstScript = document.querySelector(
    'script[src^="https://challenges.cloudflare.com/turnstile/"]',
  )!;
  fireEvent.error(firstScript);
  fireEvent.click(screen.getByRole("button", { name: "Retry security check" }));
  const secondScript = document.querySelector(
    'script[src^="https://challenges.cloudflare.com/turnstile/"]',
  )!;
  expect(secondScript).not.toBe(firstScript);
  windowWithWidget.turnstile = widgetApi;
  fireEvent.load(secondScript);
  verified();
  expect(screen.getByText(/Security check complete/)).toBeInTheDocument();
  expect(screen.getByLabelText("Contact email")).toHaveValue(
    "reporter@example.test",
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

test("server verification failure renews the widget and displays only the finite recovery message", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 403,
    json: async () => ({
      code: "verification_failed",
      error: "PRIVATE_PROVIDER_ERROR",
    }),
  });
  render(<ReportForm available siteKey="synthetic-site-key" />);
  fill();
  verified();
  submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "complete the new check",
  );
  await waitFor(() => expect(widgets).toHaveLength(2));
  expect(screen.queryByText("PRIVATE_PROVIDER_ERROR")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Contact email")).toHaveValue(
    "reporter@example.test",
  );
  submit();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
