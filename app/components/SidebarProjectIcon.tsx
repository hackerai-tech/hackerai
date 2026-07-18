import { ChevronRight, Folder, FolderOpen, Laptop } from "lucide-react";

interface SidebarProjectIconProps {
  open: boolean;
  isLocal: boolean;
}

export function SidebarProjectIcon({ open, isLocal }: SidebarProjectIconProps) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      {open ? (
        <FolderOpen
          className="absolute size-4 transition-opacity group-hover/project:opacity-0 touch-device:!opacity-100"
          data-testid="project-folder-open"
          aria-hidden="true"
        />
      ) : (
        <Folder
          className="absolute size-4 transition-opacity group-hover/project:opacity-0 touch-device:!opacity-100"
          data-testid="project-folder-closed"
          aria-hidden="true"
        />
      )}
      {isLocal ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 flex size-2.5 items-center justify-center rounded-[2px] bg-sidebar text-blue-500 transition-opacity group-hover/project:opacity-0 touch-device:!opacity-100"
          data-testid="project-local-folder-badge"
          aria-hidden="true"
        >
          <Laptop className="size-2 stroke-[2.5]" />
        </span>
      ) : null}
      <ChevronRight
        className={`absolute size-[18px] text-sidebar-foreground/45 opacity-0 transition-[transform,opacity] duration-200 group-hover/project:opacity-100 touch-device:!opacity-0 ${open ? "rotate-90" : ""}`}
        data-testid="project-chevron"
        aria-hidden="true"
      />
    </span>
  );
}
