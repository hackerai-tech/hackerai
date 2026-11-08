"use client";
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Cloud,
  GraduationCap,
  Check,
  X,
  Loader2,
  Newspaper,
  PanelLeft,
  Plus,
  ShieldCheck,
} from "lucide-react";
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
import { ScheduleRow } from "./ScheduleRow";

const TEMPLATES = [
  {
    icon: Newspaper,
    name: "Morning security brief",
    description: "Catch up on advisories and notable CVEs.",
    prompt:
      "Summarize notable security advisories, actively exploited vulnerabilities, and CVEs from the last 24 hours using public sources. Link each source and highlight practical takeaways. Do not scan or probe any systems.",
    days: [1, 2, 3, 4, 5],
    time: "08:00",
    label: "Weekdays · 08:00",
  },
  {
    icon: ShieldCheck,
    name: "Weekly security checklist",
    description: "Build a practical checklist for the week.",
    prompt:
      "Create a short security maintenance checklist for an individual developer. Include dependency updates, account security, backups, and one practical learning goal. Use public sources for any current advisories. Do not access or scan external systems.",
    days: [1],
    time: "09:00",
    label: "Mondays · 09:00",
  },
  {
    icon: GraduationCap,
    name: "Security learning session",
    description: "Practice a concept with a short quiz and lab idea.",
    prompt:
      "Teach me one practical web security concept. Include a concise explanation, three questions with answers at the end, and one exercise for a legal local practice lab. Do not scan any external systems.",
    days: [5],
    time: "17:00",
    label: "Fridays · 17:00",
  },
];
// Header and body share one column so titles and content line up.
const COLUMN = "mx-auto w-full max-w-3xl";
const STARTER =
  "group flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5";
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
  async function action(
    schedule: AgentSchedule,
    kind: "run" | "pause" | "resume",
  ) {
    setPending(schedule.id);
    setActionError("");
    setMessage("");
    try {
      await perform("PATCH", { id: schedule.id, action: kind });
      setMessage(
        kind === "run"
          ? "Run queued. Your new task will appear here shortly."
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b py-3">
        <div
          className={`${COLUMN} flex min-h-10 items-center gap-3 px-4 sm:px-6`}
        >
          {!chatSidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="-ml-1 md:hidden"
              aria-label="Open task sidebar"
              onClick={() => setChatSidebarOpen(true)}
            >
              <PanelLeft className="size-5" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight">Schedules</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Run prompts automatically and review each result as a task.
            </p>
          </div>
          <Button
            size="sm"
            className="h-11 shrink-0 sm:h-8"
            disabled={!canCreate}
            onClick={() => setForm({ definition: defaultSchedule() })}
          >
            <Plus className="size-4" />
            <span>New schedule</span>
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto" aria-busy={isLoading}>
        <div className={`${COLUMN} space-y-5 px-4 py-6 sm:px-6 sm:py-8`}>
          {isLoading && (
            <div role="status" className="space-y-3">
              <span className="sr-only">Loading schedules</span>
              <Skeleton className="h-4 w-40" />
              <div className="divide-y rounded-xl border">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="space-y-3 px-4 py-4 sm:px-5">
                    <Skeleton className="h-4 w-48 max-w-full" />
                    <Skeleton className="h-3 w-32" />
                    <div className="grid grid-cols-2 gap-6 pt-2">
                      {[0, 1].map((fact) => (
                        <div key={fact} className="space-y-2">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-4 w-28 max-w-full" />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && !data && (
            <div
              role="alert"
              className="rounded-xl border border-dashed px-6 py-10 text-center"
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
              className="rounded-xl border bg-muted/30 px-4 py-3.5 sm:px-5"
            >
              <h2 className="text-sm font-medium">
                Schedules aren’t available for this account yet
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Scheduled cloud runs require a paid plan and early access. You
                can still pause or delete existing schedules.
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
            <section aria-labelledby="empty-schedules" className="space-y-4">
              <div className="max-w-xl">
                <h2
                  id="empty-schedules"
                  className="text-base font-semibold tracking-tight"
                >
                  No schedules yet
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Pick a starting point. You’ll review the instructions and
                  timing before anything runs.
                </p>
              </div>
              <ul
                className="divide-y overflow-hidden rounded-xl border"
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
                      <t.icon
                        className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 self-start sm:flex sm:items-baseline sm:gap-4">
                        <span className="block min-w-0 sm:flex-1">
                          <span className="block text-sm font-medium">
                            {t.name}
                          </span>
                          <span className="mt-0.5 block text-sm text-muted-foreground">
                            {t.description}
                          </span>
                        </span>
                        <span className="mt-1.5 block text-xs tabular-nums text-muted-foreground sm:mt-0 sm:w-28 sm:shrink-0 sm:text-left">
                          {t.label}
                        </span>
                      </span>
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className={STARTER}
                    onClick={() => setForm({ definition: defaultSchedule() })}
                  >
                    <Plus
                      className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        Start from scratch
                      </span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">
                        Write your own instructions and timing.
                      </span>
                    </span>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              </ul>
            </section>
          )}
          {data && data.schedules.length > 0 && (
            <section className="space-y-3">
              <p className="text-xs tabular-nums text-muted-foreground">
                {data.schedules.length} of {MAX_SCHEDULES} schedules ·{" "}
                {data.schedules.filter((s) => s.enabled).length} active
              </p>
              <ul
                className="divide-y overflow-hidden rounded-xl border"
                aria-label="Your schedules"
              >
                {data.schedules.map((schedule) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    enabled={data.enabled}
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
            <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
              <Cloud className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                HackerAI runs schedules in the cloud, even when you’re away.
                Each run starts a new task and uses your account’s normal
                limits.
              </span>
            </p>
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
