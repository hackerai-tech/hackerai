import { execFileSync } from "node:child_process";

// The app's Jest mapper substitutes this dependency. A child process exercises
// the actual installed pnpm patch, including rejected RAFs and scroll timers.
const scenario = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(require.resolve("jest-environment-jsdom"))("jsdom");
const dom = new JSDOM("<div id='root'></div>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
});
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
const frames = new Map();
let nextFrame = 0;
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++nextFrame, callback);
  return nextFrame;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStickToBottom } = await import("use-stick-to-bottom");
let hook;
function Fixture() {
  hook = useStickToBottom({ resize: "smooth", initial: "instant" });
  return createElement("div", { ref: hook.scrollRef },
    createElement("div", { ref: hook.contentRef }, "Message text"));
}
const root = createRoot(document.getElementById("root"));
await act(async () => root.render(createElement(Fixture)));
const scroll = hook.scrollRef.current;
Object.defineProperties(scroll, {
  scrollHeight: { value: 1000 },
  clientHeight: { value: 100 },
});
const outside = document.createElement("div");
outside.textContent = "Sidebar text";
document.body.append(outside);

const [entry, selectionKind] = process.argv[1].split(":");
if (selectionKind === "inside" || selectionKind === "outside") {
  const range = document.createRange();
  range.selectNodeContents(selectionKind === "inside" ? hook.contentRef.current : outside);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
} else {
  const failure = () => { throw new Error('Permission denied to access property "contains"'); };
  const selectedNode = selectionKind === "protected-node"
    ? new Proxy({}, { get: failure })
    : outside;
  window.getSelection = () => ({
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: selectedNode }),
  });
  if (selectionKind === "protected-argument") scroll.contains = failure;
}
document.dispatchEvent(new window.MouseEvent("mousedown"));

async function frame() {
  await act(async () => {
    mock.timers.tick(16);
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  });
}
try {
  if (entry === "raf") {
    let outcome;
    act(() => {
      Promise.resolve(hook.scrollToBottom({ animation: "instant" })).then(
        (value) => { outcome = { value }; },
        (error) => { outcome = { error }; },
      );
    });
    await frame();
    await frame();
    if (selectionKind === "inside") {
      assert.equal(scroll.scrollTop, 0, "Selecting messages must pause auto-follow");
      assert.equal(outcome, undefined);
      document.dispatchEvent(new window.MouseEvent("mouseup"));
    }
    for (let i = 0; i < 4 && !outcome; i++) await frame();
    assert.deepEqual(outcome, { value: true }, "Auto-follow must complete, not retain a rejected animation");
    assert.equal(scroll.scrollTop, 899);
  } else {
    // Dragging down toward the bottom must reattach even after escaping.
    act(() => hook.stopScroll());
    await act(async () => {
      scroll.scrollTop = 400;
      scroll.dispatchEvent(new window.Event("scroll"));
      mock.timers.tick(1);
    });
    await act(async () => {
      scroll.scrollTop = 899;
      scroll.dispatchEvent(new window.Event("scroll"));
      mock.timers.tick(1);
    });
    assert.equal(hook.escapedFromLock, selectionKind === "inside");
    assert.equal(hook.state.isAtBottom, selectionKind !== "inside");
  }
} finally {
  document.dispatchEvent(new window.MouseEvent("mouseup"));
  await act(async () => root.unmount());
  frames.clear();
  mock.timers.reset();
  dom.window.close();
}
`;

describe.each(["raf", "scroll"])("chat selection during %s", (entry) => {
  it.each(["inside", "outside", "protected-node", "protected-argument"])(
    "preserves auto-follow and selection escape for %s selections",
    (selection) => {
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--unhandled-rejections=strict",
          "-e",
          scenario,
          `${entry}:${selection}`,
        ],
        { cwd: process.cwd(), env: {}, encoding: "utf8", timeout: 10_000 },
      );
    },
  );
});
