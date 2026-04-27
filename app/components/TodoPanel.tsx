"use client";

import React, { useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ChatStatus } from "@/types";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  SharedTodoItem,
  getStatusIcon,
} from "@/components/ui/shared-todo-item";
import { getTodoStats } from "@/lib/utils/todo-utils";

interface TodoPanelProps {
  status?: ChatStatus;
  placement?: "chat" | "sidebar";
}

export const TodoPanel = ({ status, placement = "chat" }: TodoPanelProps) => {
  const {
    todos,
    isTodoPanelExpanded: isExpanded,
    setIsTodoPanelExpanded,
    sidebarOpen,
  } = useGlobalState();

  // Deduplicate todos by id (keep last occurrence, consistent with backend)
  const uniqueTodos = Array.from(
    new Map(todos.map((todo) => [todo.id, todo])).values(),
  );

  const stats = getTodoStats(uniqueTodos);

  // Don't show panel if no todos exist
  const hasTodos = uniqueTodos.length > 0;

  // Show panel only when there are active todos (hide when all are finished)
  const hasActiveTodos = stats.inProgress > 0 || stats.pending > 0;

  // If panel is not visible, ensure global state is reset
  useEffect(() => {
    if (!hasTodos || !hasActiveTodos) {
      setIsTodoPanelExpanded(false);
    }
  }, [hasTodos, hasActiveTodos, setIsTodoPanelExpanded]);

  if (!hasTodos) {
    return null;
  }

  if (!hasActiveTodos) {
    return null;
  }

  if (placement === "chat" && sidebarOpen) {
    return null;
  }

  if (placement === "sidebar" && !sidebarOpen) {
    return null;
  }

  const handleToggleExpand = () => {
    setIsTodoPanelExpanded(!isExpanded);
  };

  // Find the "current" todo: prefer in-progress, otherwise the most recent
  // completed/cancelled action. Pending-only is handled with a count fallback.
  const currentTodoIndex = (() => {
    const inProgressIdx = uniqueTodos.findIndex(
      (t) => t.status === "in_progress",
    );
    if (inProgressIdx !== -1) return inProgressIdx;
    for (let i = uniqueTodos.length - 1; i >= 0; i--) {
      const s = uniqueTodos[i].status;
      if (s === "completed" || s === "cancelled") return i;
    }
    return -1;
  })();

  const currentTodo =
    currentTodoIndex !== -1 ? uniqueTodos[currentTodoIndex] : undefined;

  // When the chat is idle but a todo is still in_progress, the user manually
  // stopped the agent — surface the in_progress todo as paused.
  const isPaused = status === "ready" && stats.inProgress > 0;
  const currentTodoDisplayStatus =
    currentTodo && isPaused && currentTodo.status === "in_progress"
      ? "paused"
      : currentTodo?.status;

  const headerText = isExpanded
    ? "Task progress"
    : currentTodo
      ? currentTodo.content
      : stats.done === 0
        ? `${stats.total} To-dos`
        : `${stats.done} of ${stats.total} To-dos`;

  const headerCounter = currentTodo
    ? `${currentTodoIndex + 1} / ${stats.total}`
    : null;

  const panelClassName =
    placement === "sidebar"
      ? "rounded-[16px] shadow-[0px_4px_32px_0px_rgba(0,0,0,0.04)] border border-black/8 dark:border-border bg-input-chat overflow-hidden"
      : "mx-4 rounded-[22px_22px_0px_0px] shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border border-b-0 bg-input-chat";

  const listMaxHeightClass =
    placement === "sidebar"
      ? "max-h-[min(calc(100vh-360px),400px)]"
      : "max-h-[200px]";

  const panel = (
    <div className={panelClassName}>
      {/* Header */}
      <button
        onClick={handleToggleExpand}
        className="flex items-center w-full gap-2 pl-3 pr-4 py-2 hover:opacity-80 transition-opacity cursor-pointer focus:outline-none"
        aria-label={isExpanded ? "Collapse todos" : "Expand todos"}
      >
        {!isExpanded && currentTodo && currentTodoDisplayStatus ? (
          <span className="flex-shrink-0">
            {getStatusIcon(currentTodoDisplayStatus)}
          </span>
        ) : null}
        <h3
          className="text-muted-foreground text-sm font-medium truncate text-left flex-1 min-w-0"
          title={headerText}
        >
          {headerText}
        </h3>
        {headerCounter && (
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {headerCounter}
          </span>
        )}
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}
      </button>

      {/* Todo List - Collapsible */}
      {isExpanded && (
        <div
          className={`border-t border-border px-4 py-3 space-y-2 overflow-y-auto ${listMaxHeightClass}`}
        >
          {uniqueTodos.map((todo) => (
            <SharedTodoItem key={todo.id} todo={todo} isPaused={isPaused} />
          ))}
        </div>
      )}
    </div>
  );

  // In the computer sidebar, anchor the panel to the bottom of a fixed-height
  // placeholder so the expanded list overlays the timeline above it instead of
  // pushing the timeline up.
  if (placement === "sidebar") {
    return (
      <div className="relative z-50 mt-3 min-h-[40px]">
        <div className="absolute bottom-0 left-0 right-0">{panel}</div>
      </div>
    );
  }

  return panel;
};
