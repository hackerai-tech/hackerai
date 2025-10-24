"use client";

import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChatStatus } from "@/types";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { SharedTodoItem } from "@/components/ui/shared-todo-item";
import { getTodoStats } from "@/lib/utils/todo-utils";

interface TodoPanelProps {
  status: ChatStatus;
}

export const TodoPanel = ({ status }: TodoPanelProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { todos, setIsTodoPanelExpanded } = useGlobalState();

  // Deduplicate todos by id (keep last occurrence, consistent with backend)
  const uniqueTodos = Array.from(
    new Map(todos.map((todo) => [todo.id, todo])).values(),
  );

  const stats = getTodoStats(uniqueTodos);

  // Don't show panel if no todos exist
  const hasTodos = uniqueTodos.length > 0;

  // Reflect expansion to global state
  useEffect(() => {
    setIsTodoPanelExpanded(isExpanded);
    return () => {
      setIsTodoPanelExpanded(false);
    };
  }, [isExpanded, setIsTodoPanelExpanded]);

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

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  const getHeaderText = () => {
    if (stats.done === 0) {
      return `${stats.total} To-dos`;
    }
    return `${stats.done} of ${stats.total} To-dos`;
  };

  return (
    <div className="mx-4 rounded-[22px_22px_0px_0px] shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border border-b-0 bg-input-chat">
      {/* Header */}
      <div
        className={`flex items-center px-4 transition-all duration-300 py-2`}
      >
        <button
          onClick={handleToggleExpand}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer focus:outline-none rounded-md p-1 -m-1 flex-1"
          aria-label={isExpanded ? "Collapse todos" : "Expand todos"}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggleExpand();
            }
          }}
        >
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
          <div className="flex items-center gap-2">
            <h3 className="text-muted-foreground text-sm font-medium">
              {getHeaderText()}
            </h3>
          </div>
        </button>
      </div>

      {/* Todo List - Collapsible */}
      {isExpanded && (
        <div className="border-t border-border px-4 py-3 space-y-2 max-h-[200px] overflow-y-auto">
          {uniqueTodos.map((todo) => (
            <SharedTodoItem key={todo.id} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
};
