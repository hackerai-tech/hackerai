"use client";
import Link from "next/link";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  Ellipsis,
  Loader2,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { describeTiming } from "@/lib/schedules/recurrence";
import type { AgentSchedule, ScheduleRun } from "@/lib/schedules/types";

const LABELS: Record<string, string> = {
  queued: "Queued",
  uncertain_start: "Start unconfirmed",
  unconfirmed: "Unconfirmed",
  starting: "Starting",
  started: "Started",
  running: "Running",
  finished: "Finished",
  finishing: "Finishing",
  failed: "Failed",
  skipped: "Skipped",
  canceled: "Canceled",
  deleted: "Task deleted",
};
function RunResult({ run }: { run: ScheduleRun }) {
  const hasTask = run.hasTask && run.status !== "deleted";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        className={
          run.status === "failed" ? "text-destructive" : "text-muted-foreground"
        }
      >
        {LABELS[run.status] ?? run.status} ·{" "}
        {new Date(run.createdAt).toLocaleString([], {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </span>
      {hasTask && (
        <Link
          href={`/c/${run.chatId}`}
          onClick={() =>
            captureAuthenticatedEvent("agent_schedule_result_opened", {
              run_status: run.status,
            })
          }
          className="inline-flex items-center gap-0.5 text-foreground underline-offset-4 hover:underline"
        >
          View task
          <ArrowUpRight className="size-3" />
        </Link>
      )}
      {run.detail && (
        <span className="w-full text-muted-foreground">{run.detail}</span>
      )}
    </div>
  );
}
export function ScheduleRow({
  schedule,
  enabled,
  pending,
  onAction,
  onEdit,
  onDelete,
}: {
  schedule: AgentSchedule;
  enabled: boolean;
  pending: boolean;
  onAction: (action: "run" | "pause" | "resume") => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [history, setHistory] = useState(false);
  const latest = schedule.runs[0];
  const busy =
    latest &&
    [
      "queued",
      "starting",
      "started",
      "running",
      "finishing",
      "uncertain_start",
    ].includes(latest.status);
  const completed = !schedule.enabled && schedule.consumed;
  return (
    <li className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="hidden size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 sm:flex">
          <CalendarClock className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words text-sm font-medium">
              {schedule.definition.name}
            </h2>
            <Badge
              variant="outline"
              className="rounded-full px-2 py-0 text-[11px] font-normal"
            >
              {schedule.enabled ? "Active" : completed ? "One-time" : "Paused"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {describeTiming(schedule.definition.timing)}
            {schedule.definition.timing.type === "weekly" && (
              <span className="block text-xs sm:ml-1 sm:inline">
                {" "}
                · {schedule.definition.timing.timezone.replaceAll("_", " ")}
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Next run{" "}
            <span className="ml-1 text-foreground">
              {schedule.enabled && schedule.nextRunAt
                ? new Date(schedule.nextRunAt).toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "short",
                    ...(schedule.definition.timing.type === "weekly"
                      ? { timeZone: schedule.definition.timing.timezone }
                      : {}),
                  })
                : completed
                  ? "No further runs"
                  : "Paused"}
            </span>
          </p>
          {latest ? (
            <RunResult run={latest} />
          ) : (
            <p className="text-xs text-muted-foreground">No runs yet</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !enabled || Boolean(busy)}
            onClick={() => onAction("run")}
            aria-label={`Run ${schedule.definition.name} now`}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Run now
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={pending}
                aria-label={`More actions for ${schedule.definition.name}`}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit} disabled={!enabled}>
                <Pencil className="size-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onAction(schedule.enabled ? "pause" : "resume")}
                disabled={!schedule.enabled && !enabled}
              >
                {schedule.enabled ? (
                  <Pause className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
                {schedule.enabled ? "Pause" : "Resume"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-4" />
                Delete schedule
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {schedule.runs.length > 1 && (
        <div className="mt-3 sm:ml-[52px]">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setHistory(!history)}
            aria-expanded={history}
          >
            <ChevronDown
              className={`size-3 transition-transform ${history ? "rotate-180" : ""}`}
            />
            Recent runs
          </button>
          {history && (
            <div className="mt-2 space-y-3 border-l pl-3">
              {schedule.runs.slice(1).map((run) => (
                <RunResult key={run.id} run={run} />
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
