"use client";
import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  Cloud,
  GraduationCap,
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
      <header className="shrink-0 border-b px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {!chatSidebarOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 md:hidden"
                aria-label="Open task sidebar"
                onClick={() => setChatSidebarOpen(true)}
              >
                <PanelLeft className="size-5" />
              </Button>
            )}
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Schedules
              </h1>
              <p className="hidden text-sm text-muted-foreground sm:block">
                Your prompts, on a schedule.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            disabled={!canCreate}
            onClick={() => setForm({ definition: defaultSchedule() })}
          >
            <Plus className="size-4" />
            <span>New schedule</span>
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto" aria-busy={isLoading}>
        <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
          <div className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
            <Cloud className="mt-0.5 size-4 shrink-0" />
            <p>
              HackerAI runs your instructions in the cloud, even when you’re
              away. Each run starts a new task and uses your account’s normal
              limits.
            </p>
          </div>
          {isLoading && (
            <div role="status" className="space-y-3">
              <span className="sr-only">Loading schedules</span>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-28 w-full rounded-xl" />
              ))}
            </div>
          )}
          {error && !data && (
            <div
              role="alert"
              className="rounded-xl border border-dashed p-8 text-center"
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
            <div role="status" className="rounded-xl border bg-muted/30 p-5">
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
            <p
              role="status"
              className="rounded-lg border bg-muted/30 px-3 py-2 text-sm"
            >
              {message}
            </p>
          )}
          {actionError && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive"
            >
              {actionError}
            </p>
          )}
          {data?.enabled && data.schedules.length === 0 && (
            <section className="py-5" aria-labelledby="empty-schedules">
              <div className="mb-7 max-w-lg">
                <div className="mb-4 flex size-11 items-center justify-center rounded-xl border bg-muted/40">
                  <CalendarClock className="size-5" />
                </div>
                <h2
                  id="empty-schedules"
                  className="text-xl font-semibold tracking-tight"
                >
                  Make time for the work that repeats
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Start with a daily brief, a weekly checklist, or your own
                  routine. Pick a template and make it yours.
                </p>
              </div>
              <ul className="grid gap-3 sm:grid-cols-3">
                {TEMPLATES.map((t) => (
                  <li key={t.name}>
                    <button
                      type="button"
                      className="flex h-full w-full flex-col gap-4 rounded-xl border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      <t.icon className="size-5 text-muted-foreground" />
                      <div>
                        <h3 className="text-sm font-medium">{t.name}</h3>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                          {t.description}
                        </p>
                      </div>
                      <span className="mt-auto text-xs text-muted-foreground">
                        {t.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                className="mt-5"
                size="sm"
                onClick={() => setForm({ definition: defaultSchedule() })}
              >
                <Plus className="size-4" />
                Start from scratch
              </Button>
            </section>
          )}
          {data && data.schedules.length > 0 && (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {data.schedules.filter((s) => s.enabled).length} active ·{" "}
                  {data.schedules.length} total
                </span>
                <span>Up to {MAX_SCHEDULES} schedules</span>
              </div>
              <ul
                className="divide-y rounded-xl border"
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
            </>
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
