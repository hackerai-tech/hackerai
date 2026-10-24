"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  Folder,
} from "lucide-react";
import {
  WORKSPACE_DOWNLOAD_LIMIT,
  WORKSPACE_PREVIEW_LIMIT,
  type WorkspaceEntry,
  type WorkspaceListing,
} from "@/lib/sandbox/workspace-files";
import {
  workspaceImageTypes,
  workspaceTextExtensions,
} from "@/lib/workspace-preview/format";

export function canPreviewWorkspaceFile(entry: WorkspaceEntry) {
  return (
    entry.kind === "file" &&
    entry.size <= WORKSPACE_PREVIEW_LIMIT &&
    (!entry.name.includes(".") ||
      workspaceTextExtensions.test(entry.name) ||
      !!workspaceImageTypes[entry.name.split(".").pop()?.toLowerCase() ?? ""])
  );
}

type TreeProps = {
  initial: WorkspaceListing;
  rootLabel?: string;
  load: (
    path: string,
    offset: number,
    signal: AbortSignal,
  ) => Promise<WorkspaceListing | null>;
  onFile: (entry: WorkspaceEntry, path: string, download: boolean) => void;
  selected?: string;
  filter: string;
  busy: boolean;
};

export function WorkspaceFileTree(props: TreeProps) {
  return (
    <nav aria-label="Workspace file tree">
      <Directory
        {...props}
        path=""
        name={props.rootLabel ?? "/home/user"}
        initial={props.initial}
      />
    </nav>
  );
}

/** Each expanded folder owns its request and pagination; collapsing it cancels
 * outstanding reads. Refresh remounts the tree so no stale descendants survive. */
function Directory({
  path,
  name,
  initial,
  ...props
}: Omit<TreeProps, "initial"> & {
  path: string;
  name: string;
  initial?: WorkspaceListing;
}) {
  const [open, setOpen] = useState(!path);
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const fetchPage = async (offset: number) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await props.load(path, offset, controller.signal);
      if (!controller.signal.aborted && next)
        setData((previous) => ({
          ...next,
          entries: offset
            ? [...(previous?.entries ?? []), ...next.entries]
            : next.entries,
        }));
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Unable to read folder.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => () => pending.current?.abort(), []);
  const toggle = () => {
    if (open) {
      pending.current?.abort();
      setLoading(false);
    } else if (!data) void fetchPage(0);
    setOpen(!open);
  };
  const entries =
    data?.entries.filter(
      (entry) =>
        entry.kind === "directory" ||
        entry.name
          .toLocaleLowerCase()
          .includes(props.filter.toLocaleLowerCase()),
    ) ?? [];
  return (
    <div>
      <button
        type="button"
        aria-label={`${open ? "Collapse" : "Expand"} folder ${name}`}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (
            (event.key === "ArrowRight" && !open) ||
            (event.key === "ArrowLeft" && open)
          ) {
            event.preventDefault();
            toggle();
          }
        }}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0" />
        ) : (
          <ChevronRight size={14} className="shrink-0" />
        )}
        <Folder size={15} className="shrink-0 text-muted-foreground" />
        <span className="truncate" title={name}>
          {name}
        </span>
      </button>
      {open && (
        <div className="ml-2 border-l pl-2">
          {loading && (
            <p role="status" className="p-2 text-xs">
              Loading {name}…
            </p>
          )}
          {error && (
            <div role="alert" className="p-2 text-xs">
              {error}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => void fetchPage(data?.nextOffset ?? 0)}
              >
                Retry {name}
              </button>
            </div>
          )}
          {!loading && data && !entries.length && (
            <p className="p-2 text-xs text-muted-foreground">
              {props.filter ? "No matching files." : "Empty folder"}
            </p>
          )}
          <ul>
            {entries.map((entry) => {
              const entryPath = path ? `${path}/${entry.name}` : entry.name;
              if (entry.kind === "directory")
                return (
                  <li key={entryPath}>
                    <Directory {...props} path={entryPath} name={entry.name} />
                  </li>
                );
              const previewable = canPreviewWorkspaceFile(entry);
              return (
                <li
                  key={entryPath}
                  className={`flex min-w-0 items-center rounded ${props.selected === entryPath ? "bg-muted" : "hover:bg-muted/50"}`}
                >
                  <button
                    type="button"
                    disabled={!previewable || props.busy}
                    aria-label={`${previewable ? "Preview" : "File"} ${entry.name}`}
                    aria-current={
                      props.selected === entryPath ? "true" : undefined
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 p-2 text-left text-sm disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring"
                    title={`${entryPath} · ${entry.size} bytes${entry.kind !== "file" ? " · Link or special file blocked" : ""}`}
                    onClick={() => props.onFile(entry, entryPath, false)}
                  >
                    <File
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{entry.name}</span>
                  </button>
                  {entry.kind === "file" && (
                    <button
                      type="button"
                      aria-label={`Download ${entry.name}`}
                      disabled={
                        props.busy || entry.size > WORKSPACE_DOWNLOAD_LIMIT
                      }
                      onClick={() => props.onFile(entry, entryPath, true)}
                      className="shrink-0 rounded p-2 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Download size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {data?.nextOffset != null && (
            <button
              type="button"
              disabled={loading}
              className="p-2 text-xs underline"
              onClick={() => void fetchPage(data.nextOffset!)}
            >
              Load more in {name}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
