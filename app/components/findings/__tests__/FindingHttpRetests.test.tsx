import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const mockCapture = jest.fn();

Object.defineProperty(global, "ResizeObserver", {
  configurable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

const { FindingHttpRetests } =
  require("../FindingHttpRetests") as typeof import("../FindingHttpRetests");
const { initialRecipeForm, recipeFromForm } =
  require("../FindingRetestRecipeEditor") as typeof import("../FindingRetestRecipeEditor");

const finding = {
  finding_id: "finding-1",
  title: "Invoice IDOR",
  target: "https://app.example.test/api/invoices/:id",
};

const recipe = {
  version: 1,
  title: "Invoice IDOR",
  origin: "https://app.example.test",
  timeout_ms: 8000,
  credentials: [
    {
      name: "tester_token",
      label: "Tester account token",
      placement: "bearer",
    },
  ],
  baselines: [
    {
      label: "Baseline · own record",
      method: "GET",
      path: "/api/invoices/inv_1002",
      credential: "tester_token",
      headers: [],
      expect: {
        status: 200,
        json: [{ json_path: "owner_id", equals: "usr_tester_b" }],
        body_contains: [],
      },
    },
  ],
  probe: {
    label: "Cross-account · victim's record",
    method: "GET",
    path: "/api/invoices/inv_1001",
    credential: "tester_token",
    headers: [],
    vulnerable: {
      status: 200,
      json: [{ json_path: "owner_id", equals: "usr_victim_a" }],
      body_contains: [],
    },
    not_reproduced: { statuses: [403, 404] },
  },
};

const finishedRun = {
  run_id: "run-1",
  request_id: "request-1",
  status: "finished",
  recipe_version: 1,
  recipe,
  started_at: Date.now() - 60_000,
  finished_at: Date.now() - 59_000,
  outcome: "reproduced",
  reason: "vulnerable_predicate_matched",
  environment: { kind: "desktop", name: "MacBook Pro" },
  evidence_sha256: "3f9a".padEnd(60, "0") + "c21e",
  steps: [
    {
      kind: "baseline",
      index: 0,
      status: 200,
      bytes: 412,
      body_sha256: "4ab2".padEnd(60, "1") + "e019",
      duration_ms: 84,
      error: "none",
      matched: true,
      checks: [true],
    },
    {
      kind: "probe",
      index: 0,
      status: 200,
      bytes: 405,
      body_sha256: "9c1e".padEnd(60, "2") + "7b04",
      duration_ms: 91,
      error: "none",
      matched: true,
      checks: [true],
      nonreproduction_matched: false,
    },
  ],
};

const enabledState = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  finding: {
    finding_id: "finding-1",
    chat_title: "Scan",
    target: finding.target,
  },
  environment: { kind: "local", revision: "a".repeat(64) },
  recipe: { version: 1, recipe, source: "agent", created_at: 1 },
  runs: [finishedRun],
  server_time: Date.now(),
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

let fetchMock: jest.Mock<any>;

describe("FindingHttpRetests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn();
    Object.defineProperty(global, "fetch", {
      configurable: true,
      value: fetchMock,
    });
  });

  it("renders nothing when the rollout is disabled", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ enabled: false }));
    const { container } = render(<FindingHttpRetests finding={finding} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("shows the latest result, snapshot and history with no raw bodies", async () => {
    fetchMock.mockResolvedValue(jsonResponse(enabledState()));
    render(<FindingHttpRetests finding={finding} />);
    // Latest result and its history row.
    expect(await screen.findAllByText("Reproduced")).toHaveLength(2);
    expect(screen.getByText("Latest run")).toBeInTheDocument();
    expect(screen.getByText("Run snapshot locked")).toBeInTheDocument();
    expect(screen.getByText("MATCH")).toBeInTheDocument();
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText(/body sha256:9c1e…7b04/)).toBeInTheDocument();
    expect(screen.getByText("Run history")).toBeInTheDocument();
    expect(mockCapture).toHaveBeenCalledWith(
      "finding_http_retest_section_viewed",
      { has_recipe: true, run_count: 1 },
    );
  });

  it("labels rejected baseline authentication consistently with a skipped run", async () => {
    const rejected = {
      ...finishedRun,
      outcome: "skipped",
      reason: "auth_rejected",
      steps: [
        {
          ...finishedRun.steps[0],
          status: 401,
          matched: false,
        },
      ],
    };
    fetchMock.mockResolvedValue(
      jsonResponse(enabledState({ runs: [rejected] })),
    );
    render(<FindingHttpRetests finding={finding} />);
    expect(await screen.findByText("AUTH")).toBeInTheDocument();
    expect(screen.getByText("Rejected as unauthenticated")).toBeInTheDocument();
    expect(
      screen.queryByText("Did not match the expected baseline response"),
    ).not.toBeInTheDocument();
  });

  it("runs only after explicit authorization and clears the credential", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ success: true, run: finishedRun })
        : jsonResponse(enabledState()),
    );
    render(<FindingHttpRetests finding={finding} />);
    await user.click(
      await screen.findByRole("button", { name: /run retest/i }),
    );
    const dialog = await screen.findByRole("dialog");
    const run = within(dialog).getByRole("button", { name: /run 2 requests/i });
    expect(run).toBeDisabled();
    const token = within(dialog).getByLabelText(/tester account token/i);
    expect(token).toHaveAttribute("type", "password");
    await user.type(token, "synthetic-token");
    expect(run).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(run);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    )!;
    expect(JSON.parse(post[1].body)).toMatchObject({
      findingId: "finding-1",
      recipeVersion: 1,
      reviewedOrigin: "https://app.example.test",
      reviewedEnvironment: "a".repeat(64),
      authorized: true,
      credentials: { tester_token: "synthetic-token" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /run retest/i }));
    expect(
      within(await screen.findByRole("dialog")).getByLabelText(
        /tester account token/i,
      ),
    ).toHaveValue("");
  });

  it("offers a recipe editor when there is no recipe and saves with OCC", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? jsonResponse({ success: true, version: 1 })
        : jsonResponse(enabledState({ recipe: null, runs: [] })),
    );
    render(<FindingHttpRetests finding={finding} />);
    expect(await screen.findByText("No executable recipe")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run retest/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /add http recipe/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByDisplayValue("https://app.example.test"),
    ).toBeInTheDocument();
    const paths = within(dialog).getAllByPlaceholderText(
      "/api/invoices/inv_1002",
    );
    await user.clear(paths[0]);
    await user.type(paths[0], "/api/invoices/inv_1002");
    await user.clear(paths[1]);
    await user.type(paths[1], "/api/invoices/inv_1001");
    await user.click(
      within(dialog).getByRole("button", { name: /save recipe/i }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
      ).toBe(true),
    );
    const put = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    )!;
    const sent = JSON.parse(put[1].body);
    expect(sent).toMatchObject({ findingId: "finding-1", expectedVersion: 0 });
    expect(sent.recipe.probe.not_reproduced.statuses).toEqual([403, 404]);
    expect(JSON.stringify(sent)).not.toMatch(/token\W*:\W*"[^"]*secret/i);
  });

  it("rejects empty or invalid typed JSON identity values", () => {
    const draft = initialRecipeForm(recipe, finding);
    draft.probe.predicate.checks[0] = {
      json_path: "owner_id",
      type: "number",
      value: "",
    };
    expect(recipeFromForm(draft)).toEqual({
      success: false,
      message: "Enter a valid number for every JSON identity check.",
    });

    draft.probe.predicate.checks[0] = {
      json_path: "is_owner",
      type: "boolean",
      value: "yes",
    };
    expect(recipeFromForm(draft)).toEqual({
      success: false,
      message: "Boolean JSON identity checks must be true or false.",
    });
  });

  it("refreshes the recipe after an optimistic concurrency conflict", async () => {
    const user = userEvent.setup();
    let reads = 0;
    let puts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts++;
        return puts === 1
          ? jsonResponse({ message: "conflict" }, 409)
          : jsonResponse({ success: true, version: 3 });
      }
      reads++;
      return jsonResponse(
        enabledState({
          recipe: {
            version: reads === 1 ? 1 : 2,
            recipe: {
              ...recipe,
              title: reads === 1 ? recipe.title : "Updated",
            },
            source: "agent",
            created_at: 1,
          },
        }),
      );
    });
    render(<FindingHttpRetests finding={finding} />);
    await user.click(
      await screen.findByRole("button", { name: /edit recipe/i }),
    );
    await user.click(screen.getByRole("button", { name: /save recipe/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/newer recipe/i);
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await user.click(screen.getByRole("button", { name: /edit recipe/i }));
    expect(screen.getByDisplayValue("Updated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save recipe/i }));
    await waitFor(() => expect(puts).toBe(2));
    const secondPut = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    )[1];
    expect(JSON.parse(secondPut[1].body)).toMatchObject({ expectedVersion: 2 });
  });

  it("keeps request credential references aligned on rename and removal", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(enabledState()));
    render(<FindingHttpRetests finding={finding} />);
    await user.click(
      await screen.findByRole("button", { name: /edit recipe/i }),
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog)
      .getAllByRole("textbox")
      .find(
        (field) =>
          field instanceof HTMLInputElement && field.value === "tester_token",
      )!;
    await user.clear(name);
    await user.type(name, "account_token");
    expect(
      within(dialog)
        .getAllByLabelText("Credential")
        .every(
          (select) => (select as HTMLSelectElement).value === "account_token",
        ),
    ).toBe(true);

    await user.click(
      within(dialog).getByRole("button", {
        name: /remove credential account_token/i,
      }),
    );
    expect(
      within(dialog)
        .getAllByLabelText("Credential")
        .every((select) => (select as HTMLSelectElement).value === ""),
    ).toBe(true);
  });
});
