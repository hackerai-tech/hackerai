import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { codeToHtml } from "shiki";
import { TerminalCodeBlock } from "../TerminalCodeBlock";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => null,
}));

jest.mock("shiki", () => ({
  codeToHtml: jest.fn(
    async (code: string) => `<pre><code>${code}</code></pre>`,
  ),
}));

jest.mock("@/lib/utils/shiki", () => ({
  isWebAssemblyAvailable: () => true,
}));

const terminal = (output: string) => (
  <TerminalCodeBlock
    command="synthetic-stream"
    output={output}
    isExecuting
    status="streaming"
    variant="sidebar"
  />
);

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

describe("TerminalCodeBlock streaming progress", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows fresh output during a continuous stream and retains the final chunk", async () => {
    const { container, rerender } = render(terminal("chunk 0"));
    for (let chunk = 1; chunk <= 2; chunk++) {
      await advance(50);
      rerender(terminal(`chunk ${chunk}`));
    }
    await advance(50);
    expect(container.querySelector("code")).toHaveTextContent("chunk 2");

    for (let chunk = 3; chunk <= 8; chunk++) {
      rerender(terminal(`chunk ${chunk}`));
      await advance(50);
    }
    await advance(150);
    expect(container.querySelector("code")).toHaveTextContent("chunk 8");
    expect(screen.queryByText("Processing output...")).not.toBeInTheDocument();
  });

  it("does not render queued output after the terminal unmounts", async () => {
    const { unmount } = render(terminal("unmounted output"));
    await advance(50);
    unmount();
    await advance(200);
    expect(codeToHtml).not.toHaveBeenCalled();
  });

  it("does not replace newer output when an earlier highlight finishes late", async () => {
    let finishOldRender!: (html: string) => void;
    jest.mocked(codeToHtml).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldRender = resolve;
        }),
    );
    const { container, rerender } = render(terminal("old pending chunk"));
    await advance(150);
    rerender(terminal("new visible chunk"));
    await advance(150);
    expect(container.querySelector("code")).toHaveTextContent(
      "new visible chunk",
    );

    await act(async () => {
      finishOldRender("<pre><code>old pending chunk</code></pre>");
    });
    expect(container.querySelector("code")).toHaveTextContent(
      "new visible chunk",
    );
  });
});
