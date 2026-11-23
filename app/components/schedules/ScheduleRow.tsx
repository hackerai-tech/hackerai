"use client";
import Link from "next/link";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleDashed,
  Cloud,
  Ellipsis,
  Laptop,
  Loader2,
  Monitor,
  Pause,
  Play,
  Trash2,
  Unplug,
  WifiOff,
  X,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { describeTiming, formatNextRun } from "@/lib/schedules/recurrence";
import { isDesktopPreference } from "@/lib/sandbox/environment";
import type { AgentSchedule, ScheduleRun } from "@/lib/schedules/types";

// Three tiers follow the page container, so an open sidebar is accounted for:
// a phone stack, then name + actions above three labelled facts from @xl, then
// the table from @5xl. Shared with the column headers in SchedulesPage; the
// fixed next-run and action lanes keep headers aligned with every row. The
// schedule lane is wide enough for status and a weekly cadence on one line.
export const SCHEDULE_COLUMNS =
  "@5xl:grid-cols-[minmax(0,1.5fr)_10rem_minmax(0,1fr)_minmax(0,1.4fr)_11rem] @5xl:gap-x-6";
// Bordered 44px targets on phones; quiet text actions from the middle tier up.
const ROW_ACTION =
  "h-11 flex-1 border @xl:h-8 @xl:flex-none @xl:border-transparent";
const ROW_LINK =
  "inline-flex min-h-11 items-center gap-1 rounded-md font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @xl:min-h-8";

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
  interrupted: "Connection lost",
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
// The icon mirrors the stored run status; it never implies success on its own.
function StatusIcon({ status }: { status: string }) {
  const className = "size-3.5 shrink-0";
  if (status === "finished")
    return (
      <Check
        className={cn(className, "text-emerald-700 dark:text-emerald-500")}
      />
    );
  if (status === "failed")
    return <CircleAlert className={cn(className, "text-destructive")} />;
  if (BUSY.includes(status))
    return (
      <Loader2
        className={cn(
          className,
          "text-muted-foreground motion-safe:animate-spin",
        )}
      />
    );
  if (status === "unconfirmed")
    return <CircleDashed className={cn(className, "text-muted-foreground")} />;
  if (status === "skipped")
    return <Ban className={cn(className, "text-muted-foreground")} />;
  if (status === "interrupted")
    return <Unplug className={cn(className, "text-muted-foreground")} />;
  if (status === "canceled")
    return <X className={cn(className, "text-muted-foreground")} />;
  return <Circle className={cn(className, "text-muted-foreground")} />;
}
function formatRunTime(at: number) {
  return new Date(at).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
// Rows show a short date; the exact time stays in the title.
function formatRunDate(at: number) {
  return new Date(at).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(new Date(at).getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}
// Saved findings only. The count is capped by the server, never estimated.
function findingsLabel(schedule: AgentSchedule) {
  const count = schedule.findingCount ?? 0;
  if (count <= 0) return null;
  if (schedule.findingCountTruncated) return `${count}+ findings`;
  return count === 1 ? "1 finding" : `${count} findings`;
}
// The latest finished task's distinct findings, split by whether an earlier
// task already saved them. Unknown or zero counts show nothing.
function runFindingParts(run: ScheduleRun | undefined) {
  const summary = run?.findingSummary;
  if (!summary) return [];
  const parts: string[] = [];
  if (summary.newCount > 0)
    parts.push(
      summary.newCount === 1
        ? "1 new finding"
        : `${summary.newCount} new findings`,
    );
  if (summary.repeatCount > 0) parts.push(`${summary.repeatCount} seen again`);
  return parts;
}
function RunStatus({ run }: { run: ScheduleRun }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-flex">
        <StatusIcon status={run.status} />
      </span>
      <span
        className={cn(
          "font-medium",
          run.status === "failed" ? "text-destructive" : "text-foreground",
        )}
      >
        {LABELS[run.status] ?? run.status}
      </span>
    </span>
  );
}
function RunTaskLink({
  run,
  className,
}: {
  run: ScheduleRun;
  className?: string;
}) {
  if (!run.hasTask || run.status === "deleted") return null;
  return (
    <Link
      href={`/c/${run.chatId}`}
      onClick={() =>
        captureAuthenticatedEvent("agent_schedule_result_opened", {
          run_status: run.status,
        })
      }
      className={cn(ROW_LINK, className)}
    >
      {/* An interrupted run continues only from its task; the schedule's own
          Resume button restarts future runs and is a different action. */}
      {run.status === "finished"
        ? "Open result"
        : run.status === "interrupted"
          ? "Resume in task"
          : "Open task"}
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}
export function ScheduleRow({
  schedule,
  enabled,
  computerUnavailable,
  pending,
  onAction,
  onEdit,
  onDelete,
}: {
  schedule: AgentSchedule;
  enabled: boolean;
  computerUnavailable: boolean;
  pending: boolean;
  onAction: (action: "run" | "pause" | "resume") => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const historyId = useId();
  const unavailableId = useId();
  const [history, setHistory] = useState(false);
  const latest = schedule.runs[0];
  const busy = latest && BUSY.includes(latest.status);
  const hasLatestTask = latest?.hasTask && latest.status !== "deleted";
  const { name, timing, execution } = schedule.definition;
  const completed =
    !schedule.enabled && schedule.consumed && timing.type === "once";
  const canToggle = schedule.enabled || (!completed && enabled);
  const unavailable = computerUnavailable && Boolean(execution);
  const findings = findingsLabel(schedule);
  const runFindings = runFindingParts(latest);
  const ExecutionIcon = !execution
    ? Cloud
    : isDesktopPreference(execution.preference)
      ? Monitor
      : Laptop;
  const fact =
    "grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 @xl:block";
  const term = "text-xs text-muted-foreground @xl:mb-1 @5xl:sr-only";
  return (
    <li
      className={cn(
        "grid grid-cols-1 gap-y-3 py-4 @xl:grid-cols-[minmax(0,1fr)_auto] @xl:gap-x-4 @5xl:items-start",
        SCHEDULE_COLUMNS,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-base font-medium break-words wrap-anywhere">
          {name}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3">
          <p className="min-w-0 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              {schedule.enabled ? (
                <span
                  className="size-2 rounded-full bg-foreground"
                  aria-hidden="true"
                />
              ) : completed ? (
                <Check className="size-3" aria-hidden="true" />
              ) : (
                <Pause className="size-3 fill-current" aria-hidden="true" />
              )}
              {schedule.enabled ? "Active" : completed ? "Ended" : "Paused"}
            </span>
            <span className="break-words">
              {" · "}
              {describeTiming(timing)}
            </span>
          </p>
          {findings && (
            <Link
              href={`/findings?schedule=${encodeURIComponent(schedule.id)}`}
              // Content-free: no schedule, target or finding details.
              onClick={() =>
                captureAuthenticatedEvent("agent_schedule_findings_opened")
              }
              aria-label={`${findings} from ${name}`}
              // The 44px phone target overlaps only the static lines around
              // it, so the row grows by one text line.
              className={cn(
                ROW_LINK,
                "-my-3 text-sm tabular-nums @xl:my-0 @xl:min-h-7 @xl:text-[13px]",
              )}
            >
              {findings}
            </Link>
          )}
        </div>
      </div>
      <dl className="grid min-w-0 gap-y-2.5 text-sm @xl:col-span-2 @xl:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)] @xl:gap-x-6 @5xl:col-span-3 @5xl:grid-cols-subgrid">
        <div className={fact}>
          <dt className={term}>Next run</dt>
          <dd className="min-w-0 tabular-nums">
            {schedule.enabled && schedule.nextRunAt ? (
              <span
                className="font-medium text-foreground"
                title={
                  timing.type === "weekly"
                    ? timing.timezone.replaceAll("_", " ")
                    : undefined
                }
              >
                {formatNextRun(schedule.nextRunAt, {
                  timeZone:
                    timing.type === "weekly" ? timing.timezone : undefined,
                })}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {completed ? "No further runs" : "None while paused"}
              </span>
            )}
          </dd>
        </div>
        <div className={fact}>
          <dt className={term}>Runs on</dt>
          <dd className="min-w-0">
            <span className="flex items-start gap-1.5">
              <ExecutionIcon
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span
                className="line-clamp-2 min-w-0 font-medium wrap-anywhere"
                title={
                  execution
                    ? `${execution.name}\n${execution.workingDirectory}`
                    : undefined
                }
              >
                {execution ? execution.name : "Cloud"}
                {execution && (
                  <span className="sr-only">
                    , starting folder {execution.workingDirectory}
                  </span>
                )}
              </span>
            </span>
            {unavailable && (
              // The one unavailable notice on the row. Run now is described
              // by it; "How schedules work" carries the same rule in full.
              <p
                id={unavailableId}
                title="Skipped runs aren’t made up later and never move to the cloud."
                className="mt-0.5 flex items-start gap-1.5 text-amber-700 dark:text-amber-500"
              >
                <WifiOff
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  Unavailable, runs skipped
                  <span className="sr-only">
                    . Skipped runs aren’t made up later and never move to the
                    cloud.
                  </span>
                </span>
              </p>
            )}
          </dd>
        </div>
        <div className={fact}>
          <dt className={term}>Latest result</dt>
          <dd className="min-w-0">
            {latest ? (
              <>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <RunStatus run={latest} />
                  <time
                    dateTime={new Date(latest.createdAt).toISOString()}
                    title={formatRunTime(latest.createdAt)}
                    className="tabular-nums text-muted-foreground"
                  >
                    {formatRunDate(latest.createdAt)}
                  </time>
                </span>
                {runFindings.length > 0 && (
                  // Each count stays whole when a narrow column wraps.
                  <span className="mt-0.5 block tabular-nums text-muted-foreground">
                    {runFindings.map((part, index) => (
                      <Fragment key={part}>
                        {index > 0 && " · "}
                        <span className="whitespace-nowrap">{part}</span>
                      </Fragment>
                    ))}
                  </span>
                )}
                {latest.detail && (
                  <span className="mt-0.5 block break-words text-muted-foreground">
                    {latest.detail}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">No runs yet</span>
            )}
            {(hasLatestTask || schedule.runs.length > 1) && (
              <span className="flex flex-wrap items-center gap-x-4 @xl:mt-0.5 @xl:gap-x-3 @xl:text-[13px]">
                {latest && <RunTaskLink run={latest} />}
                {schedule.runs.length > 1 && (
                  <button
                    type="button"
                    className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-sm px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @xl:ml-0 @xl:min-h-8 @xl:px-0"
                    onClick={() => setHistory(!history)}
                    aria-expanded={history}
                    aria-controls={historyId}
                  >
                    <ChevronDown
                      className={cn(
                        "size-3.5 transition-transform motion-reduce:transition-none",
                        history && "rotate-180",
                      )}
                      aria-hidden="true"
                    />
                    Recent runs
                    <span className="tabular-nums">
                      ({schedule.runs.length - 1})
                    </span>
                  </button>
                )}
              </span>
            )}
          </dd>
        </div>
      </dl>
      {history && (
        <ul
          id={historyId}
          aria-label={`Recent runs for ${name}`}
          className="divide-y rounded-lg border px-3 text-sm @xl:col-span-full @xl:px-4"
        >
          {schedule.runs.slice(1).map((run) => (
            <li
              key={run.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2 @2xl:grid-cols-[10rem_12rem_minmax(0,1fr)_auto]"
            >
              <RunStatus run={run} />
              <span className="col-start-1 row-start-2 tabular-nums text-muted-foreground @2xl:col-start-auto @2xl:row-start-auto">
                {formatRunTime(run.createdAt)}
              </span>
              <span className="col-start-1 min-w-0 break-words text-muted-foreground empty:hidden @2xl:col-start-auto">
                {run.detail}
              </span>
              <RunTaskLink
                run={run}
                className="col-start-2 row-span-2 row-start-1 justify-self-end @2xl:col-start-auto @2xl:row-span-1 @2xl:row-start-auto"
              />
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          "flex items-center gap-2 @xl:col-start-2 @xl:row-start-1 @xl:-mt-1 @xl:justify-end @xl:gap-1 @xl:self-start @5xl:col-start-5 @5xl:mt-0",
          !enabled && !schedule.enabled && "@max-xl:justify-end",
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            ROW_ACTION,
            "@xl:w-14",
            !enabled && "hidden @xl:inline-flex",
          )}
          disabled={pending || !enabled}
          onClick={onEdit}
          aria-label={`Edit ${name}`}
        >
          Edit
        </Button>
        {canToggle ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn(ROW_ACTION, "@xl:w-[4.75rem]")}
            disabled={pending}
            onClick={() => onAction(schedule.enabled ? "pause" : "resume")}
            aria-label={`${schedule.enabled ? "Pause" : "Resume"} schedule ${name}`}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : schedule.enabled ? (
              "Pause"
            ) : (
              "Resume"
            )}
          </Button>
        ) : (
          // Keeps Edit in its lane on rows that can no longer be resumed.
          <span
            className="hidden w-[4.75rem] shrink-0 @xl:block"
            aria-hidden="true"
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 @xl:size-8"
              disabled={pending}
              aria-label={`More actions for ${name}`}
            >
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => onAction("run")}
              disabled={pending || !enabled || Boolean(busy)}
              aria-describedby={unavailable ? unavailableId : undefined}
              className={cn(unavailable && "items-start")}
            >
              <Play className={cn("size-4", unavailable && "mt-0.5")} />
              <span>
                Run now
                {unavailable && (
                  <span
                    aria-hidden="true"
                    className="block text-xs text-amber-700 dark:text-amber-500"
                  >
                    Skipped while unavailable
                  </span>
                )}
              </span>
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
    </li>
  );
}
