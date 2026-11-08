"use client";
import Link from "next/link";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  ArrowUpRight,
  ChevronDown,
  Ellipsis,
  Loader2,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
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
const BUSY = [
  "queued",
  "starting",
  "started",
  "running",
  "finishing",
  "uncertain_start",
];
// Dot color mirrors the stored run status; it never implies success on its own.
function statusDot(status: string) {
  if (status === "finished") return "bg-emerald-500";
  if (status === "failed") return "bg-destructive";
  if (BUSY.includes(status)) return "bg-amber-500 motion-safe:animate-pulse";
  if (status === "unconfirmed") return "bg-amber-500";
  return "bg-muted-foreground/50";
}
function RunResult({ run }: { run: ScheduleRun }) {
  const hasTask = run.hasTask && run.status !== "deleted";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            statusDot(run.status),
          )}
          aria-hidden="true"
        />
        <span
          className={
            run.status === "failed"
              ? "font-medium text-destructive"
              : "text-foreground"
          }
        >
          {LABELS[run.status] ?? run.status}
        </span>
      </span>
      <span className="tabular-nums text-muted-foreground">
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
          className="inline-flex min-h-11 items-center gap-0.5 rounded-sm px-1 font-medium sm:min-h-6 sm:px-0 text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View task
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      )}
      {run.detail && (
        <span className="w-full break-words text-muted-foreground">
          {run.detail}
        </span>
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
  const historyId = useId();
  const [history, setHistory] = useState(false);
  const latest = schedule.runs[0];
  const busy = latest && BUSY.includes(latest.status);
  const completed = !schedule.enabled && schedule.consumed;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-5">
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="min-w-0 break-words text-[15px] font-medium">
            {schedule.definition.name}
          </h2>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[11px] text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                schedule.enabled ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
              aria-hidden="true"
            />
            {schedule.enabled ? "Active" : completed ? "Ended" : "Paused"}
          </span>
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {describeTiming(schedule.definition.timing)}
          {schedule.definition.timing.type === "weekly" &&
            ` · ${schedule.definition.timing.timezone.replaceAll("_", " ")}`}
        </p>
      </div>
      <div className="col-span-2 row-start-3 flex justify-end sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <Button
          variant="outline"
          size="sm"
          className="h-11 sm:h-8"
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
      </div>
      <div className="-mr-1 col-start-2 row-start-1 sm:col-start-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 sm:size-8"
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
      <dl className="col-span-2 row-start-2 grid gap-3 text-xs sm:col-span-3 sm:grid-cols-2 sm:gap-x-6">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 sm:block sm:space-y-1.5">
          <dt className="text-muted-foreground">Next run</dt>
          <dd
            className={cn(
              "min-w-0 tabular-nums",
              schedule.enabled && schedule.nextRunAt
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
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
                : "None while paused"}
          </dd>
        </div>
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 sm:block sm:space-y-1.5">
          <dt className="text-muted-foreground">Last run</dt>
          <dd className="min-w-0">
            {latest ? (
              <RunResult run={latest} />
            ) : (
              <span className="text-muted-foreground">No runs yet</span>
            )}
          </dd>
          {schedule.runs.length > 1 && (
            <dd className="col-start-2 min-w-0 sm:mt-1">
              <button
                type="button"
                className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-sm px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7"
                onClick={() => setHistory(!history)}
                aria-expanded={history}
                aria-controls={historyId}
              >
                <ChevronDown
                  className={cn(
                    "size-3 transition-transform motion-reduce:transition-none",
                    history && "rotate-180",
                  )}
                  aria-hidden="true"
                />
                Recent runs
                <span className="tabular-nums">
                  ({schedule.runs.length - 1})
                </span>
              </button>
              {history && (
                <div id={historyId} className="mt-1.5 space-y-2 border-l pl-3">
                  {schedule.runs.slice(1).map((run) => (
                    <RunResult key={run.id} run={run} />
                  ))}
                </div>
              )}
            </dd>
          )}
        </div>
      </dl>
    </li>
  );
}
