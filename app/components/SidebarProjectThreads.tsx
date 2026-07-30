"use client";

import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import Loading from "@/components/ui/loading";
import { useProjectThreads } from "@/app/hooks/useProjects";
import ChatItem from "./ChatItem";

interface SidebarProjectThreadsProps {
  project: Doc<"projects">;
}

export function SidebarProjectThreads({ project }: SidebarProjectThreadsProps) {
  const { results, status, loadMore } = useProjectThreads(project._id);

  if (status === "LoadingFirstPage") {
    return (
      <div
        className="flex h-9 items-center justify-center ps-9 pe-2"
        aria-label="Loading tasks"
      >
        <Loading size={5} />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <p
        className="flex h-9 items-center ps-9 pe-2 text-sm text-sidebar-foreground/35"
        data-testid={`project-${project._id}-empty`}
      >
        No tasks yet
      </p>
    );
  }

  return (
    <div data-testid={`project-${project._id}-threads`}>
      <div className="flex w-full flex-col gap-px">
        {results.map((chat) => (
          <ChatItem
            key={chat._id}
            id={chat.id}
            title={chat.title}
            projectId={project._id}
            indentContent
            isBranched={!!chat.branched_from_chat_id}
            branchedFromTitle={chat.branched_from_title}
            shareId={chat.share_id}
            isPinned={chat.pinned_at != null}
            isStreaming={
              !!chat.active_stream_id ||
              !!chat.active_trigger_run_id ||
              !!chat.active_agent_approval_pending
            }
            isAwaitingApproval={!!chat.active_agent_approval_pending}
          />
        ))}
      </div>

      {status === "LoadingMore" ? (
        <div className="flex justify-center py-2">
          <Loading size={5} />
        </div>
      ) : null}

      {status === "CanLoadMore" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ms-7 h-9 px-2 text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
          onClick={() => loadMore(10)}
        >
          Show more
        </Button>
      ) : null}
    </div>
  );
}
