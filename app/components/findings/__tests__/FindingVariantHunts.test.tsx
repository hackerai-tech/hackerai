import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  FindingVariantHunts,
  useFindingHuntState,
} from "../FindingVariantHunts";
import { notifyFindingHuntChanged } from "@/lib/findings/hunt-events";
import type {
  FindingHuntCandidateView,
  FindingHuntState,
  FindingHuntView,
} from "@/types/finding";

const candidate = (
  overrides: Partial<FindingHuntCandidateView> = {},
): FindingHuntCandidateView => ({
  candidate_key: "invoice-pdf",
  surface: "GET /api/invoices/{invoice_id}/pdf",
  rationale: "Same invoice loader without an owner check.",
  outcome: "reproduced",
  evidence_basis: "runtime_check",
  reproduction_steps: ["Own PDF as tester A", "Tester B's PDF as tester A"],
  expected_result: "403 for tester B's PDF",
  observed_result: "200 with tester B's PDF",
  evidence_refs: ["/workspace/evidence/hunt-pdf.txt"],
  evidence_verification: {
    checked_refs: ["/workspace/evidence/hunt-pdf.txt"],
    unavailable_refs: [],
  },
  limitations: ["Signed download links weren't checked."],
  recorded_at: Date.now() - 60_000,
  ...overrides,
});

const hunt = (overrides: Partial<FindingHuntView> = {}): FindingHuntView => ({
  hunt_id: "h1",
  chat_id: "chat-1",
  assistant_message_id: "message-9",
  status: "finished",
  started_at: Date.now() - 120_000,
  finished_at: Date.now() - 60_000,
  summary: "The ownership gap is on 2 sibling endpoints.",
  limitations: ["History endpoint was not reached."],
  environment: { kind: "cloud" },
  candidates: [
    candidate(),
    candidate({
      candidate_key: "invoice-export",
      surface: "POST /api/invoices/export?format=csv&account_id={account_id}",
      outcome: "inconclusive",
      evidence_basis: "source_review_only",
      observed_result: "403: role member can't export",
      evidence_refs: [],
      evidence_verification: undefined,
      limitations: ["Needs an admin test account."],
    }),
  ],
  ...overrides,
});

const state = (
  hunts: FindingHuntView[],
): Extract<FindingHuntState, { enabled: true }> => ({
  enabled: true,
  chat_title: "Invoice API authz review",
  hunts,
});

it("leads a completed hunt with its candidates, then the summary, with limits behind Not covered", () => {
  render(<FindingVariantHunts state={state([hunt()])} />);
  expect(screen.getByText("Hunt complete")).toBeVisible();
  const summary = screen.getByText(
    "The ownership gap is on 2 sibling endpoints.",
  );
  expect(summary).toBeVisible();
  // Candidate rows are reachable without opening any disclosure, and come
  // before the summary.
  const firstRow = screen.getByRole("button", { name: /^Reproduced:/ });
  expect(
    firstRow.compareDocumentPosition(summary) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The hunt's limitations stay complete but collapsed under a label.
  expect(screen.queryByText("History endpoint was not reached.")).toBeNull();
  const notCovered = screen.getByRole("button", { name: "Not covered (1)" });
  expect(notCovered).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(notCovered);
  expect(notCovered).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("History endpoint was not reached.")).toBeVisible();
  expect(screen.getByText(/not certification/)).toBeVisible();
  expect(screen.getByRole("link", { name: /Open in task/ })).toHaveAttribute(
    "href",
    "/c/chat-1#message=message-9",
  );
  // Collapsed by default: no evidence wall, no checkboxes, no severity.
  expect(screen.queryByText("Tester B's PDF as tester A")).toBeNull();
  expect(document.querySelector("input")).toBeNull();
  expect(screen.queryByText(/critical|high|CVSS/i)).toBeNull();

  const row = screen.getByRole("button", {
    name: "Reproduced: GET /api/invoices/{invoice_id}/pdf",
  });
  expect(row).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(row);
  expect(row).toHaveAttribute("aria-expanded", "true");
  const details = row.closest("li")!;
  for (const text of [
    "Same invoice loader without an owner check.",
    "Tester B's PDF as tester A",
    "403 for tester B's PDF",
    "200 with tester B's PDF",
    "Runtime reproduced",
    "/workspace/evidence/hunt-pdf.txt",
    "File found",
    "Signed download links weren't checked.",
  ])
    expect(within(details).getByText(text)).toBeVisible();
  // The other candidate stays collapsed.
  expect(screen.queryByText("Needs an admin test account.")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /^Inconclusive: POST/ }));
  expect(screen.getByText("Source review only")).toBeVisible();
});

it("labels a runtime check that ruled a surface out as checked, not reproduced", () => {
  render(
    <FindingVariantHunts
      state={state([
        hunt({
          candidates: [
            candidate({
              candidate_key: "attachments",
              surface: "GET /api/invoices/{id}/attachments/{file}",
              outcome: "ruled_out",
              observed_result: "404 for tester B's attachment",
            }),
          ],
        }),
      ])}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Ruled out:/ }));
  expect(screen.getByText("Runtime checked")).toBeVisible();
  expect(screen.queryByText("Runtime reproduced")).toBeNull();
});

it("while running shows only candidates the Agent actually saved", () => {
  render(
    <FindingVariantHunts
      state={state([
        hunt({
          status: "running",
          finished_at: undefined,
          summary: undefined,
          limitations: undefined,
          candidates: [candidate()],
        }),
      ])}
    />,
  );
  expect(screen.getByText("Agent is hunting")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 candidate saved so far",
  );
  expect(screen.getAllByRole("button", { name: /^Reproduced:/ })).toHaveLength(
    1,
  );
  expect(screen.queryByText(/Assessing|Not examined/)).toBeNull();
  expect(screen.getByRole("link", { name: /Watch in task/ })).toHaveAttribute(
    "href",
    "/c/chat-1",
  );
});

it("keeps saved candidates after an interrupted run and invents none", () => {
  render(
    <FindingVariantHunts
      state={state([
        hunt({
          interrupted: true,
          summary: undefined,
          limitations: undefined,
          candidates: [candidate()],
        }),
      ])}
    />,
  );
  expect(screen.getByText("Hunt stopped early")).toBeVisible();
  expect(
    screen.getByText(/This assessment was saved.*wasn't examined/),
  ).toBeVisible();
  expect(screen.getAllByRole("button", { name: /^Reproduced:/ })).toHaveLength(
    1,
  );
  expect(screen.queryByRole("button", { name: /^Not examined/ })).toBeNull();
});

it("shows a recorded not-examined candidate as its own outcome", () => {
  render(
    <FindingVariantHunts
      state={state([
        hunt({
          candidates: [
            candidate({
              candidate_key: "history",
              surface: "GET /api/invoices/{invoice_id}/history",
              outcome: "not_examined",
              evidence_basis: undefined,
              reproduction_steps: [],
              expected_result: undefined,
              observed_result: undefined,
              evidence_refs: [],
              evidence_verification: undefined,
              limitations: ["Run ended before it was tested."],
            }),
          ],
        }),
      ])}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Not examined: GET /api/invoices/{invoice_id}/history",
    }),
  );
  expect(screen.getByText("Run ended before it was tested.")).toBeVisible();
  expect(screen.queryByText("Observed")).toBeNull();
  expect(screen.queryByText("Basis")).toBeNull();
});

it("keeps earlier hunts behind one disclosure and explains the empty state", () => {
  const { rerender } = render(
    <FindingVariantHunts
      state={state([
        hunt(),
        hunt({
          hunt_id: "h0",
          interrupted: true,
          summary: undefined,
          candidates: [],
        }),
      ])}
    />,
  );
  expect(screen.queryByText("Hunt stopped early")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /1 earlier hunt/ }));
  expect(screen.getByText("Hunt stopped early")).toBeVisible();
  expect(screen.getByText(/No candidates were saved/)).toBeVisible();

  rerender(<FindingVariantHunts state={state([])} />);
  expect(screen.getByText("No hunts yet")).toBeVisible();
  expect(screen.getByText(/Nothing is sent until you send it/)).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

describe("useFindingHuntState", () => {
  const response = (body: unknown, ok = true) =>
    Promise.resolve({ ok, json: async () => body } as Response);
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  it("resolves a failed first read as disabled, never as an action", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("offline")));
    const { result } = renderHook(() => useFindingHuntState("finding-1"));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual({ enabled: false }));
  });

  it("polls only while running and keeps the last good state on a failed refresh", async () => {
    jest.useFakeTimers();
    const running = state([hunt({ status: "running", candidates: [] })]);
    fetchMock
      .mockReturnValueOnce(response(running))
      .mockReturnValueOnce(response({}, false));
    const { result } = renderHook(() => useFindingHuntState("finding-1"));
    await act(async () => {});
    expect(result.current).toEqual(running);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(running);

    const finished = state([hunt()]);
    fetchMock.mockReturnValueOnce(response(finished));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toEqual(finished);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes a mounted idle finding when a hunt write for it succeeds, then polls while running", async () => {
    jest.useFakeTimers();
    const idle = state([]);
    const running = state([hunt({ status: "running", candidates: [] })]);
    fetchMock.mockReturnValueOnce(response(idle));
    const { result, unmount } = renderHook(() =>
      useFindingHuntState("finding-1"),
    );
    await act(async () => {});
    expect(result.current).toEqual(idle);
    // Idle findings don't poll.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Another finding's hunt changes nothing here.
    act(() => notifyFindingHuntChanged("finding-2"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReturnValueOnce(response(running));
    await act(async () => notifyFindingHuntChanged("finding-1"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(running);
    fetchMock.mockReturnValueOnce(response(running));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    unmount();
    act(() => notifyFindingHuntChanged("finding-1"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never overlaps reads: a response slower than the interval still lands", async () => {
    jest.useFakeTimers();
    const running = state([hunt({ status: "running", candidates: [] })]);
    let resolveSlow!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(response(running)).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveSlow = resolve;
      }),
    );
    const { result } = renderHook(() => useFindingHuntState("finding-1"));
    await act(async () => {});
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The read takes longer than the interval; no second read starts.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const finished = state([hunt()]);
    await act(async () => {
      resolveSlow({ ok: true, json: async () => finished } as Response);
    });
    expect(result.current).toEqual(finished);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queues one follow-up read when a hunt starts during an in-flight idle read", async () => {
    let resolveIdle!: (value: Response) => void;
    const running = state([hunt({ status: "running", candidates: [] })]);
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveIdle = resolve;
        }),
      )
      .mockReturnValueOnce(response(running));
    const { result } = renderHook(() => useFindingHuntState("finding-1"));
    // The start lands while the first read is still in flight.
    act(() => {
      notifyFindingHuntChanged("finding-1");
      notifyFindingHuntChanged("finding-1");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveIdle({ ok: true, json: async () => state([]) } as Response);
    });
    // The pre-start idle response isn't the last word.
    await waitFor(() => expect(result.current).toEqual(running));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale response for a previously viewed finding", async () => {
    let resolveFirst!: (value: Response) => void;
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(response(state([])));
    const { result, rerender } = renderHook(
      ({ id }) => useFindingHuntState(id),
      { initialProps: { id: "finding-a" } },
    );
    rerender({ id: "finding-b" });
    await waitFor(() => expect(result.current).toEqual(state([])));
    await act(async () => {
      resolveFirst({
        ok: true,
        json: async () => state([hunt()]),
      } as Response);
    });
    expect(result.current).toEqual(state([]));
  });
});
