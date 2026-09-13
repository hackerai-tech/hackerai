import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { renderHook, act } from "@testing-library/react";
import type { ScopedDataUIPart } from "@/app/components/DataStreamProvider";
import {
  DATA_STREAM_BATCH_WINDOW_MS,
  useBatchedDataStreamAppend,
} from "../useBatchedDataStreamAppend";

type Updater =
  ScopedDataUIPart[] | ((current: ScopedDataUIPart[]) => ScopedDataUIPart[]);

function createStore() {
  let state: ScopedDataUIPart[] = [];
  const setDataStream = jest.fn((updater: Updater) => {
    state = typeof updater === "function" ? updater(state) : updater;
  });
  return {
    setDataStream,
    get state() {
      return state;
    },
  };
}

const part = (id: string): ScopedDataUIPart =>
  ({ type: "data-terminal", id, data: { terminal: id } }) as ScopedDataUIPart;

describe("useBatchedDataStreamAppend", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("appends every part from one window in a single state update, in order", () => {
    const store = createStore();
    const { result } = renderHook(() =>
      useBatchedDataStreamAppend(store.setDataStream),
    );

    act(() => {
      result.current.appendDataPart(part("a"));
      result.current.appendDataPart(part("b"));
      result.current.appendDataPart(part("c"));
    });
    expect(store.setDataStream).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DATA_STREAM_BATCH_WINDOW_MS);
    });
    expect(store.setDataStream).toHaveBeenCalledTimes(1);
    expect(store.state.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("opens a new window after a flush so later parts still arrive", () => {
    const store = createStore();
    const { result } = renderHook(() =>
      useBatchedDataStreamAppend(store.setDataStream),
    );

    act(() => {
      result.current.appendDataPart(part("a"));
      jest.advanceTimersByTime(DATA_STREAM_BATCH_WINDOW_MS);
    });
    act(() => {
      result.current.appendDataPart(part("b"));
      jest.advanceTimersByTime(DATA_STREAM_BATCH_WINDOW_MS);
    });

    expect(store.setDataStream).toHaveBeenCalledTimes(2);
    expect(store.state.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("clear drops pending parts so a reset chat cannot resurrect them", () => {
    const store = createStore();
    const { result } = renderHook(() =>
      useBatchedDataStreamAppend(store.setDataStream),
    );

    act(() => {
      result.current.appendDataPart(part("stale"));
      result.current.clearDataStream();
      jest.advanceTimersByTime(DATA_STREAM_BATCH_WINDOW_MS);
    });

    expect(store.setDataStream).toHaveBeenCalledTimes(1);
    expect(store.state).toEqual([]);
  });

  it("flush applies pending parts immediately", () => {
    const store = createStore();
    const { result } = renderHook(() =>
      useBatchedDataStreamAppend(store.setDataStream),
    );

    act(() => {
      result.current.appendDataPart(part("a"));
      result.current.flushDataStream();
    });

    expect(store.state.map((p) => p.id)).toEqual(["a"]);
    act(() => {
      jest.advanceTimersByTime(DATA_STREAM_BATCH_WINDOW_MS);
    });
    expect(store.setDataStream).toHaveBeenCalledTimes(1);
  });

  it("does not update state after unmount", () => {
    const store = createStore();
    const { result, unmount } = renderHook(() =>
      useBatchedDataStreamAppend(store.setDataStream),
    );

    act(() => {
      result.current.appendDataPart(part("a"));
    });
    unmount();
    act(() => {
      jest.advanceTimersByTime(DATA_STREAM_BATCH_WINDOW_MS);
    });

    expect(store.setDataStream).not.toHaveBeenCalled();
  });
});
