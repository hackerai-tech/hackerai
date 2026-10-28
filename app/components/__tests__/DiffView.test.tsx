import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DiffView } from "../DiffView";

const mockModels: Array<{ disposed: boolean; disposals: number }> = [];

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

beforeEach(() => {
  mockModels.length = 0;
});

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
