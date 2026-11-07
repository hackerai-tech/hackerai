import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DiffView } from "../DiffView";
import {
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
  confirmAuthenticatedAnalyticsUserId,
} from "@/lib/analytics/client";

const mockModels: Array<{ disposed: boolean; disposals: number }> = [];
const mockCapture = jest.fn();
const mockUuid = jest.fn();
let mockInitiallyComputed = false;
let mockSubscriptionFailure: "subscribe" | "dispose" | undefined;
const mockPostHog = { __loaded: true, capture: mockCapture };
const mockEditors: Array<{
  changes: unknown[] | null;
  emit: () => void;
  lateEmit: () => void;
  subscriptionsDisposed: number;
}> = [];

jest.mock("posthog-js", () => ({ __esModule: true, default: mockPostHog }));
jest.mock("uuid", () => ({
  ...jest.requireActual("uuid"),
  v4: (...args: unknown[]) => mockUuid(...args),
}));

jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: React.ReactNode }) => (
    <pre>{children}</pre>
  ),
}));

jest.mock("@monaco-editor/react", () => {
  const React = require("react");
  return {
    DiffEditor: (props: any) => {
      const mountProps = React.useRef(props);
      React.useEffect(() => {
        const props = mountProps.current;
        let editorDisposed = false;
        const listeners: Array<() => void> = [];
        const updates: Array<() => void> = [];
        const state = {
          changes: (mockInitiallyComputed ? [] : null) as unknown[] | null,
          subscriptionsDisposed: 0,
          emit: () => updates.forEach((listener) => listener()),
          lateEmit: () => updates.forEach((listener) => listener()),
        };
        mockEditors.push(state);
        const createModel = () => {
          const state = { disposed: false, disposals: 0 };
          mockModels.push(state);
          return {
            isDisposed: () => state.disposed,
            dispose: () => {
              if (!editorDisposed)
                throw new Error("TextModel disposed before editor teardown");
              state.disposed = true;
              state.disposals++;
            },
          };
        };
        const models = { original: createModel(), modified: createModel() };
        const dispose = () => {
          listeners.forEach((listener) => listener());
          editorDisposed = true;
        };
        props.onMount({
          getModel: () => models,
          getLineChanges: () => state.changes,
          onDidUpdateDiff: (listener: () => void) => {
            if (mockSubscriptionFailure === "subscribe")
              throw new Error("optional subscription unavailable");
            updates.push(listener);
            return {
              dispose: () => {
                state.subscriptionsDisposed++;
                if (mockSubscriptionFailure === "dispose")
                  throw new Error("optional disposer unavailable");
              },
            };
          },
          getModifiedEditor: () => ({
            onDidDispose: (listener: () => void) => listeners.push(listener),
          }),
          dispose,
        });
        return () => {
          // Public wrapper contract: keepCurrent*Model transfers ownership to
          // the caller. The inner editor's event precedes complete teardown.
          if (!props.keepCurrentOriginalModel) models.original.dispose();
          if (!props.keepCurrentModifiedModel) models.modified.dispose();
          dispose();
        };
      }, []);
      return (
        <pre>
          {props.original} → {props.modified}
        </pre>
      );
    },
  };
});

beforeAll(async () => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  await loadPostHogClient();
});

beforeEach(() => {
  mockModels.length = 0;
  mockEditors.length = 0;
  mockInitiallyComputed = false;
  mockSubscriptionFailure = undefined;
  mockUuid
    .mockReset()
    .mockImplementation(() => jest.requireActual("uuid").v4());
  mockPostHog.__loaded = true;
  setAuthenticatedAnalyticsUserId("diff-test-user");
  confirmAuthenticatedAnalyticsUserId("diff-test-user");
  mockCapture.mockReset();
});

afterEach(() => {
  setAuthenticatedAnalyticsUserId(null);
});

const capturedDiffs = () =>
  mockCapture.mock.calls
    .filter(([event]) => event === "diff_view_diagnostic")
    .map(([, properties, options]) => ({ properties, options }));

it("switches views and releases every model after editor teardown, including parent unmount", async () => {
  const view = render(
    <React.StrictMode>
      <DiffView
        originalContent="alpha=1"
        modifiedContent="alpha=2"
        language="text"
      />
    </React.StrictMode>,
  );
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
    });
    expect(screen.getByText("alpha=2")).toBeInTheDocument();
    expect(
      mockModels.every((model) => model.disposed && model.disposals === 1),
    ).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Original" }));
    expect(screen.getByText("alpha=1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  }
  await act(async () => {
    view.unmount();
  });
  expect(
    mockModels.every((model) => model.disposed && model.disposals === 1),
  ).toBe(true);
});

it("records only a nonnull computed diff and three unique rendered views per StrictMode instance", async () => {
  const view = render(
    <React.StrictMode>
      <DiffView
        originalContent="private-alpha=1"
        modifiedContent="private-alpha=2"
        language="private-language"
      />
    </React.StrictMode>,
  );
  expect(capturedDiffs()).toHaveLength(1);
  expect(capturedDiffs()[0].properties).toMatchObject({
    stage: "view_rendered",
    view_mode: "diff",
    instance_observed_computed_before_view: false,
  });
  const old = mockEditors[0];
  old.changes = [];
  act(() => old.lateEmit());
  expect(capturedDiffs()).toHaveLength(1);
  const current = mockEditors.at(-1)!;
  act(() => current.emit());
  expect(capturedDiffs()).toHaveLength(1); // reset/null is not computation
  current.changes = [];
  act(() => {
    current.emit();
    current.emit();
  });
  for (let i = 0; i < 2; i++) {
    fireEvent.click(screen.getByRole("tab", { name: "Original" }));
    fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  }
  const captures = capturedDiffs();
  expect(captures).toHaveLength(4);
  expect(captures.map(({ properties: p }) => [p.stage, p.view_mode])).toEqual([
    ["view_rendered", "diff"],
    ["computed", undefined],
    ["view_rendered", "original"],
    ["view_rendered", "modified"],
  ]);
  expect(
    new Set(captures.map(({ properties: p }) => p.diff_view_instance_id)).size,
  ).toBe(1);
  expect(new Set(captures.map(({ options: o }) => o.uuid)).size).toBe(4);
  expect(captures[2].properties.instance_observed_computed_before_view).toBe(
    true,
  );
  expect(JSON.stringify(captures)).not.toContain("private");
  await act(async () => view.unmount());
  expect(mockModels.every((m) => m.disposed && m.disposals === 1)).toBe(true);
  expect(mockEditors.every((e) => e.subscriptionsDisposed === 1)).toBe(true);
});

it("retains bounded facts until identity and SDK readiness, then flushes once", async () => {
  setAuthenticatedAnalyticsUserId(null);
  setAuthenticatedAnalyticsUserId("diff-test-user");
  mockPostHog.__loaded = false;
  render(
    <DiffView
      originalContent="alpha=1"
      modifiedContent="alpha=2"
      language="text"
    />,
  );
  const editor = mockEditors.at(-1)!;
  editor.changes = [];
  act(() => editor.emit());
  fireEvent.click(screen.getByRole("tab", { name: "Original" }));
  fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
  expect(capturedDiffs()).toHaveLength(0);
  await act(async () => {
    setAuthenticatedAnalyticsUserId("diff-test-user");
    confirmAuthenticatedAnalyticsUserId("diff-test-user");
  });
  expect(capturedDiffs()).toHaveLength(0);
  await act(async () => {
    mockPostHog.__loaded = true;
    confirmAuthenticatedAnalyticsUserId("diff-test-user");
  });
  expect(capturedDiffs()).toHaveLength(4);
  act(() => confirmAuthenticatedAnalyticsUserId("diff-test-user"));
  expect(capturedDiffs()).toHaveLength(4);
});

it("does not backfill view or computation facts observed before analytics permission", async () => {
  setAuthenticatedAnalyticsUserId(null);
  render(
    <DiffView
      originalContent="alpha=1"
      modifiedContent="alpha=2"
      language="text"
    />,
  );
  const editor = mockEditors.at(-1)!;
  editor.changes = [];
  act(() => editor.emit());
  fireEvent.click(screen.getByRole("tab", { name: "Original" }));
  fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
  await act(async () => {
    setAuthenticatedAnalyticsUserId("diff-test-user");
    confirmAuthenticatedAnalyticsUserId("diff-test-user");
  });
  expect(capturedDiffs()).toHaveLength(0);
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  expect(
    capturedDiffs().map(({ properties: p }) => [p.stage, p.view_mode]),
  ).toEqual([["view_rendered", "diff"]]);
});

it.each(["other-user", "diff-test-user"])(
  "retires the diagnostic instance across consent/account transition to %s without changing tabs",
  (nextUser) => {
    render(
      <DiffView
        originalContent="alpha=1"
        modifiedContent="alpha=2"
        language="text"
      />,
    );
    expect(capturedDiffs()).toHaveLength(1);
    act(() => {
      setAuthenticatedAnalyticsUserId(null);
      setAuthenticatedAnalyticsUserId(nextUser);
      confirmAuthenticatedAnalyticsUserId(nextUser);
    });
    const editor = mockEditors.at(-1)!;
    editor.changes = [];
    act(() => editor.emit());
    fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
    expect(screen.getByText("alpha=2")).toBeInTheDocument();
    expect(capturedDiffs()).toHaveLength(1);
  },
);

it("discards pending SDK events when consent is withdrawn before delivery", async () => {
  mockPostHog.__loaded = false;
  render(
    <DiffView
      originalContent="alpha=1"
      modifiedContent="alpha=2"
      language="text"
    />,
  );
  const editor = mockEditors.at(-1)!;
  editor.changes = [];
  act(() => editor.emit());
  expect(capturedDiffs()).toHaveLength(0);
  await act(async () => {
    setAuthenticatedAnalyticsUserId(null);
    mockPostHog.__loaded = true;
    setAuthenticatedAnalyticsUserId("diff-test-user");
    confirmAuthenticatedAnalyticsUserId("diff-test-user");
  });
  fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
  expect(capturedDiffs()).toHaveLength(0);
  expect(screen.getByText("alpha=2")).toBeInTheDocument();
});

it("retries a refused enqueue once when SDK configuration becomes available", async () => {
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  try {
    render(
      <DiffView
        originalContent="alpha=1"
        modifiedContent="alpha=2"
        language="text"
      />,
    );
    expect(capturedDiffs()).toHaveLength(0);
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    await act(async () =>
      confirmAuthenticatedAnalyticsUserId("diff-test-user"),
    );
    expect(capturedDiffs()).toHaveLength(1);
    act(() => confirmAuthenticatedAnalyticsUserId("diff-test-user"));
    expect(capturedDiffs()).toHaveLength(1);
  } finally {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  }
});

it("observes an already computed diff and keeps facts scoped to the instance across prop changes", async () => {
  const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "invalid-private-build";
  mockInitiallyComputed = true;
  const props = {
    originalContent: "alpha=1",
    modifiedContent: "alpha=2",
    language: "text",
  };
  const first = render(<DiffView {...props} />);
  expect(capturedDiffs().map(({ properties: p }) => p.stage)).toEqual([
    "computed",
    "view_rendered",
  ]);
  expect(
    capturedDiffs()[1].properties.instance_observed_computed_before_view,
  ).toBe(true);
  const firstId = capturedDiffs()[0].properties.diff_view_instance_id;
  first.rerender(<DiffView {...props} modifiedContent="alpha=3" />);
  expect(capturedDiffs()).toHaveLength(2);
  expect(
    capturedDiffs().every(
      ({ properties: p }) => p.hackerai_frontend_build_commit === "unknown",
    ),
  ).toBe(true);
  await act(async () => first.unmount());
  render(<DiffView {...props} />);
  expect(capturedDiffs()[2].properties.diff_view_instance_id).not.toBe(firstId);
  if (originalBuild === undefined)
    delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  else process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
});

it.each(["uuid", "capture"] as const)(
  "keeps tabs and model cleanup working when %s actually throws",
  async (source) => {
    const collaborator = source === "uuid" ? mockUuid : mockCapture;
    collaborator.mockImplementation(() => {
      throw new Error("private diagnostic error");
    });
    const view = render(
      <DiffView
        originalContent="alpha=1"
        modifiedContent="alpha=2"
        language="text"
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
    expect(screen.getByText("alpha=2")).toBeInTheDocument();
    expect(collaborator.mock.results.some((r) => r.type === "throw")).toBe(
      true,
    );
    await act(async () => view.unmount());
    expect(mockModels.every((m) => m.disposed && m.disposals === 1)).toBe(true);
  },
);

it.each(["subscribe", "dispose"] as const)(
  "retains model teardown when the optional diff %s fails",
  async (failure) => {
    mockSubscriptionFailure = failure;
    const view = render(
      <DiffView
        originalContent="alpha=1"
        modifiedContent="alpha=2"
        language="text"
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Original" }));
    expect(screen.getByText("alpha=1")).toBeInTheDocument();
    await act(async () => view.unmount());
    expect(mockModels.every((m) => m.disposed && m.disposals === 1)).toBe(true);
  },
);
