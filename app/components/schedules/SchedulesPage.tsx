"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  GraduationCap,
  Check,
  X,
  Loader2,
  Newspaper,
  PanelLeft,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useSchedules } from "@/app/hooks/useSchedules";
import {
  MAX_SCHEDULES,
  type ScheduleDefinition,
} from "@/lib/schedules/recurrence";
import type { AgentSchedule } from "@/lib/schedules/types";
import { ScheduleFormDialog, defaultSchedule } from "./ScheduleFormDialog";
import { SCHEDULE_COLUMNS, ScheduleRow } from "./ScheduleRow";

const TEMPLATES = [
  {
    icon: Newspaper,
    name: "Morning security brief",
    description:
      "Notable advisories and actively exploited CVEs from public sources.",
    prompt:
      "Summarize notable security advisories, actively exploited vulnerabilities, and CVEs from the last 24 hours using public sources. Link each source and highlight practical takeaways. Do not scan or probe any systems.",
    days: [1, 2, 3, 4, 5],
    time: "08:00",
    label: "Weekdays · 08:00",
  },
  {
    icon: ShieldCheck,
    name: "Weekly security checklist",
    description:
      "Dependency updates, account security, backups, and one learning goal.",
    prompt:
      "Create a short security maintenance checklist for an individual developer. Include dependency updates, account security, backups, and one practical learning goal. Use public sources for any current advisories. Do not access or scan external systems.",
    days: [1],
    time: "09:00",
    label: "Mondays · 09:00",
  },
  {
    icon: GraduationCap,
    name: "Security learning session",
    description:
      "One web security concept, a short quiz, and a local lab exercise.",
    prompt:
      "Teach me one practical web security concept. Include a concise explanation, three questions with answers at the end, and one exercise for a legal local practice lab. Do not scan any external systems.",
    days: [5],
    time: "17:00",
    label: "Fridays · 17:00",
  },
];
// Header and body share one column so titles and content line up. Widths
// respond to the page container, so an open task sidebar is accounted for.
const COLUMN = "mx-auto w-full max-w-6xl px-4 @xl:px-8 @4xl:px-12";
const STARTER =
  "group flex min-h-11 w-full min-w-0 items-center gap-4 rounded-sm py-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export function SchedulesPage() {
  const { data, error, isLoading, reload, perform } = useSchedules();
  const exposed = useRef(false);
  useEffect(() => {
    if (data?.enabled && !exposed.current) {
      exposed.current = captureAuthenticatedEvent("agent_schedules_viewed", {
        schedule_count: data.schedules.length,
      });
    }
  }, [data]);
  const { chatSidebarOpen, setChatSidebarOpen } = useGlobalState();
  const [form, setForm] = useState<{
    id?: string;
    definition: ScheduleDefinition;
  } | null>(null);
  const [deleting, setDeleting] = useState<AgentSchedule | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const canCreate = Boolean(
    data?.enabled && data.schedules.length < MAX_SCHEDULES,
  );
  const computers = data?.computers ?? [];
  async function action(
    schedule: AgentSchedule,
    kind: "run" | "pause" | "resume",
  ) {
    setPending(schedule.id);
    setActionError("");
    setMessage("");
    try {
      await perform("PATCH", { id: schedule.id, action: kind });
      const execution = schedule.definition.execution;
      setMessage(
        kind === "run"
          ? execution
            ? `Run requested on ${execution.name}. If it isn’t connected, the run is recorded as skipped.`
            : "Run queued. Your new task will appear here shortly."
          : kind === "pause"
            ? "Schedule paused. Any run already started will continue."
            : "Schedule resumed.",
      );
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Could not update schedule.",
      );
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b py-3 @4xl:border-b-0 @4xl:pt-10 @4xl:pb-4">
        <div className={`${COLUMN} flex min-h-11 items-center gap-3`}>
          {!chatSidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2 size-11 md:hidden"
              aria-label="Open task sidebar"
              onClick={() => setChatSidebarOpen(true)}
            >
              <PanelLeft className="size-5" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight @lg:text-2xl @4xl:text-[2rem] @4xl:leading-tight">
              Schedules
            </h1>
            <p className="mt-1 hidden text-sm text-muted-foreground @xl:block">
              Each run starts a new task with your instructions. Results land in
              your task history.
            </p>
          </div>
          <Button
            className="h-11 shrink-0 @lg:h-9"
            disabled={!canCreate}
            onClick={() => setForm({ definition: defaultSchedule() })}
          >
            <Plus className="size-4" />
            <span>
              New<span className="sr-only @lg:not-sr-only"> schedule</span>
            </span>
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto" aria-busy={isLoading}>
        <div className={`${COLUMN} space-y-6 pt-2 pb-10 @4xl:pt-4`}>
          {isLoading && (
            <div role="status">
              <span className="sr-only">Loading schedules</span>
              <div className="divide-y border-b">
                {[0, 1, 2].map((row) => (
                  <div
                    key={row}
                    className={cn("grid gap-3 py-5", SCHEDULE_COLUMNS)}
                  >
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-48 max-w-full" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    {[0, 1, 2].map((fact) => (
                      <div key={fact} className="hidden space-y-2 @4xl:block">
                        <Skeleton className="h-4 w-28 max-w-full" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && !data && (
            <div
              role="alert"
              className="rounded-lg border border-dashed px-6 py-10 text-center"
            >
              <h2 className="font-medium">Couldn’t load schedules</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Check your connection and try again.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => reload()}
              >
                Try again
              </Button>
            </div>
          )}
          {data && !data.enabled && (
            <div
              role="status"
              className="rounded-lg border bg-muted/30 px-4 py-3.5"
            >
              <h2 className="text-sm font-medium">
                Schedules aren’t available for this account yet
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Schedules require a paid plan and early access. You can still
                pause or delete existing schedules.
              </p>
            </div>
          )}
          {message && (
            <div
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Check className="size-4 shrink-0" aria-hidden="true" />
              <p className="flex-1">{message}</p>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 sm:size-8"
                aria-label="Dismiss confirmation"
                onClick={() => setMessage("")}
              >
                <X className="size-4" />
              </Button>
            </div>
          )}
          {actionError && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {actionError}
            </p>
          )}
          {data?.enabled && data.schedules.length === 0 && (
            <section
              aria-labelledby="empty-schedules"
              className="space-y-8 pt-4 @4xl:pt-8"
            >
              <div className="max-w-2xl space-y-2">
                <h2
                  id="empty-schedules"
                  className="text-lg font-semibold tracking-tight @lg:text-xl @4xl:text-2xl"
                >
                  Let the routine checks run themselves.
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground @lg:text-base">
                  Pick a starter, then tailor its instructions and timing.
                  Nothing runs until you save.
                </p>
              </div>
              <div>
                <h3 className="pb-2 text-xs font-medium text-muted-foreground">
                  Starters
                </h3>
                <ul
                  className="divide-y border-y"
                  aria-label="Schedule templates"
                >
                  {TEMPLATES.map((t) => (
                    <li key={t.name}>
                      <button
                        type="button"
                        className={STARTER}
                        onClick={() =>
                          setForm({
                            definition: {
                              ...defaultSchedule(),
                              name: t.name,
                              prompt: t.prompt,
                              timing: {
                                type: "weekly",
                                time: t.time,
                                weekdays: t.days,
                                timezone:
                                  Intl.DateTimeFormat().resolvedOptions()
                                    .timeZone,
                              },
                            },
                          })
                        }
                      >
                        <span
                          className="flex size-9 shrink-0 items-center justify-center self-start rounded-md border bg-muted/40 text-muted-foreground transition-colors group-hover:text-foreground"
                          aria-hidden="true"
                        >
                          <t.icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1 @xl:flex @xl:items-center @xl:gap-6">
                          <span className="block min-w-0 @xl:flex-1">
                            <span className="block text-sm font-medium underline-offset-4 group-hover:underline">
                              {t.name}
                            </span>
                            <span className="mt-0.5 block text-sm text-muted-foreground">
                              {t.description}
                            </span>
                          </span>
                          <span className="mt-1 block text-sm tabular-nums text-muted-foreground @xl:mt-0 @xl:w-36 @xl:shrink-0">
                            {t.label}
                          </span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium">
                          <span className="hidden @lg:inline">Use</span>
                          <ArrowRight
                            className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                            aria-hidden="true"
                          />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col items-start gap-3 @xl:flex-row @xl:items-center @xl:gap-4">
                <Button
                  variant="outline"
                  className="h-11 shrink-0 @lg:h-9"
                  onClick={() => setForm({ definition: defaultSchedule() })}
                >
                  <Plus className="size-4" />
                  Start from scratch
                </Button>
                <p className="text-sm text-muted-foreground">
                  Write your own instructions. Runs in the cloud unless you pick
                  a connected computer.
                </p>
              </div>
            </section>
          )}
          {data && data.schedules.length > 0 && (
            <section>
              <div
                aria-hidden="true"
                className={cn(
                  "hidden border-b pb-2.5 text-xs font-medium text-muted-foreground @4xl:grid",
                  SCHEDULE_COLUMNS,
                )}
              >
                <span>Schedule</span>
                <span>Next run</span>
                <span>Runs on</span>
                <span>Latest result</span>
              </div>
              <ul className="divide-y border-b" aria-label="Your schedules">
                {data.schedules.map((schedule) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    enabled={data.enabled}
                    computerUnavailable={Boolean(
                      schedule.definition.execution &&
                      !computers.some(
                        (computer) =>
                          computer.preference ===
                          schedule.definition.execution?.preference,
                      ),
                    )}
                    pending={pending === schedule.id}
                    onAction={(kind) => action(schedule, kind)}
                    onEdit={() =>
                      setForm({
                        id: schedule.id,
                        definition: schedule.definition,
                      })
                    }
                    onDelete={() => {
                      setDeleting(schedule);
                      setActionError("");
                    }}
                  />
                ))}
              </ul>
            </section>
          )}
          {data && (
            <div className="flex flex-col gap-3 pt-2 text-sm leading-relaxed text-muted-foreground @2xl:flex-row @2xl:items-start @2xl:justify-between @2xl:gap-8">
              <p className="max-w-2xl">
                Cloud schedules run while you’re away. Schedules on a computer
                need it connected; runs are skipped while it’s unavailable. Each
                run starts a new task and uses your account’s normal usage and
                spending limits.
              </p>
              {data.schedules.length > 0 && (
                <p className="shrink-0 tabular-nums">
                  {data.schedules.length} of {MAX_SCHEDULES} schedules
                </p>
              )}
            </div>
          )}
        </div>
      </main>
      {form && (
        <ScheduleFormDialog
          key={form.id ?? "create"}
          initial={form.definition}
          editing={Boolean(form.id)}
          saved={
            form.id ? data?.schedules.find((s) => s.id === form.id) : undefined
          }
          computers={computers}
          onClose={() => setForm(null)}
          onSave={async (definition) => {
            await perform(
              form.id ? "PATCH" : "POST",
              form.id
                ? { id: form.id, action: "save", definition }
                : definition,
            );
            setMessage(
              form.id
                ? "Schedule updated."
                : "Schedule created. Your next run is ready.",
            );
          }}
        />
      )}
      <AlertDialog
        open={Boolean(deleting)}
        pending={pending === "delete"}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.definition.name}” will stop running automatically.
              Tasks already created will stay in your history, and any run
              already started will continue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending !== "delete" && actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending === "delete"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending === "delete"}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                if (!deleting) return;
                setPending("delete");
                setActionError("");
                try {
                  await perform("DELETE", undefined, deleting.id);
                  setDeleting(null);
                  setMessage("Schedule deleted.");
                } catch (error) {
                  setActionError(
                    error instanceof Error
                      ? error.message
                      : "Could not delete schedule.",
                  );
                } finally {
                  setPending(null);
                }
              }}
            >
              {pending === "delete" && (
                <Loader2 className="mr-1 size-4 animate-spin" />
              )}
              {pending === "delete" ? "Deleting…" : "Delete schedule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
