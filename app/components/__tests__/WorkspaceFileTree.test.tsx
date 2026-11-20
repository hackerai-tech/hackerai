import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { WorkspaceFileTree } from "../WorkspaceFileTree";
import type { WorkspaceListing } from "@/lib/sandbox/workspace-files";
const entry = (name: string, kind: "file" | "directory" = "file") => ({
  name,
  kind,
  size: 12,
  modified: 0,
});
const listing = (
  entries: ReturnType<typeof entry>[],
  nextOffset: number | null = null,
): WorkspaceListing => ({
  entries,
  total: entries.length,
  nextOffset,
});
it("lazily expands folders, preserves sibling branches, paginates and selects an exact nested path", async () => {
  const onFile = jest.fn();
  const load = jest.fn(async (path, offset) =>
    listing([entry(offset ? "second.txt" : "first.txt")], offset ? null : 100),
  );
  render(
    <WorkspaceFileTree
      initial={listing([entry("reports", "directory"), entry("notes.txt")])}
      load={load}
      onFile={onFile}
      filter=""
      busy={false}
    />,
  );
  expect(load).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Expand folder reports" }),
    );
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview first.txt" }),
  );
  expect(onFile).toHaveBeenCalledWith(
    expect.objectContaining({ name: "first.txt" }),
    "reports/first.txt",
    false,
  );
  expect(
    screen.getByRole("button", { name: "Preview notes.txt" }),
  ).toBeVisible();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Load more in reports" }),
    );
  });
  expect(
    await screen.findByRole("button", { name: "Preview second.txt" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Preview first.txt" }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse folder reports" }),
  );
  expect(
    screen.queryByRole("button", { name: "Preview first.txt" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Expand folder reports" }),
    );
  });
  expect(
    screen.getByRole("button", { name: "Preview second.txt" }),
  ).toBeVisible();
  expect(load).toHaveBeenCalledTimes(2);
});
it("cancels a collapsed folder read, ignores its late result and retries on reopening", async () => {
  let resolve: (value: WorkspaceListing) => void = () => {};
  let signal: AbortSignal;
  const load = jest.fn((_path, _offset, s: AbortSignal) => {
    signal = s;
    return new Promise<WorkspaceListing>((r) => {
      resolve = r;
    });
  });
  render(
    <WorkspaceFileTree
      initial={listing([entry("reports", "directory")])}
      load={load}
      onFile={jest.fn()}
      filter=""
      busy={false}
    />,
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Expand folder reports" }),
    );
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse folder reports" }),
  );
  expect(signal!.aborted).toBe(true);
  await act(async () => resolve(listing([entry("stale.txt")])));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Expand folder reports" }),
    );
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("button", { name: "Preview stale.txt" }),
  ).not.toBeInTheDocument();
});
