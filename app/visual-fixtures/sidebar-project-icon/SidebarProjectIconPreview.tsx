"use client";

import { useState } from "react";
import { Ellipsis, SquarePen } from "lucide-react";
import { SidebarProjectIcon } from "@/app/components/SidebarProjectIcon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const ACTION_TOOLTIP_CLASS =
  "border-0 bg-black px-3 py-1.5 text-xs text-white shadow-md [&_svg]:bg-black [&_svg]:fill-black";

interface PreviewRowProps {
  id: "local" | "cloud";
  name: string;
  isLocal: boolean;
  open: boolean;
  onToggle: (id: "local" | "cloud") => void;
}

function PreviewRow({ id, name, isLocal, open, onToggle }: PreviewRowProps) {
  return (
    <div className="group/project flex h-9 items-center gap-3 rounded-[10px] bg-sidebar ps-2 pe-0.5 hover:bg-sidebar-accent/50">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
      >
        <SidebarProjectIcon open={open} isLocal={isLocal} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-lg text-sidebar-foreground/45 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-visible:opacity-100"
            aria-label={`More options for ${name}`}
          >
            <Ellipsis className="size-[18px]" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={4}
          className={ACTION_TOOLTIP_CLASS}
        >
          More options
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-lg text-sidebar-foreground/45 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-visible:opacity-100"
            aria-label={`New task in ${name}`}
          >
            <SquarePen className="size-[18px]" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={4}
          className={ACTION_TOOLTIP_CLASS}
        >
          New task
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function SidebarProjectIconPreview() {
  const [openProject, setOpenProject] = useState<"local" | "cloud" | null>(
    null,
  );

  const handleToggle = (id: "local" | "cloud") => {
    setOpenProject((current) => (current === id ? null : id));
  };

  return (
    <main className="min-h-svh bg-background px-6 py-12 text-foreground sm:px-10">
      <div className="mx-auto max-w-3xl">
        <span className="inline-flex rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400">
          Preview only
        </span>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          Sidebar project icon preview
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Compare local and cloud projects at the real 300px sidebar width.
          Hover a row to preview its chevron and actions, or click its name to
          switch the folder between closed and open.
        </p>

        <section className="mt-8 w-full max-w-[332px] rounded-2xl border border-sidebar-border bg-sidebar p-4 shadow-2xl">
          <div className="px-2.5 pb-2 text-[13px] font-medium text-sidebar-foreground/50">
            Projects
          </div>
          <div className="flex flex-col gap-px">
            <PreviewRow
              id="local"
              name="Local project"
              isLocal
              open={openProject === "local"}
              onToggle={handleToggle}
            />
            <PreviewRow
              id="cloud"
              name="Cloud project"
              isLocal={false}
              open={openProject === "cloud"}
              onToggle={handleToggle}
            />
          </div>
        </section>

        <div className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="font-medium">Local project</p>
            <p className="mt-1 text-muted-foreground">
              Folder with a blue laptop badge.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="font-medium">Cloud project</p>
            <p className="mt-1 text-muted-foreground">
              Plain folder without a device badge.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
