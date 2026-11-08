"use client";
import { useId, useState } from "react";
import { CalendarClock, Check, Cloud, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  nextScheduledTime,
  describeTiming,
  sameScheduleTiming,
  validateSchedule,
  type ScheduleDefinition,
  type ScheduleTiming,
} from "@/lib/schedules/recurrence";
import type { AgentSchedule } from "@/lib/schedules/types";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0];
const KINDS: { value: ScheduleTiming["type"]; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "interval", label: "Interval" },
  { value: "once", label: "One time" },
];
function localDateTime(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function defaultSchedule(): ScheduleDefinition {
  return {
    name: "",
    prompt: "",
    model: "default",
    timing: {
      type: "weekly",
      time: "09:00",
      weekdays: [1, 2, 3, 4, 5],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}
export function ScheduleFormDialog({
  initial,
  editing,
  saved,
  onClose,
  onSave,
}: {
  initial: ScheduleDefinition;
  editing: boolean;
  saved?: Pick<AgentSchedule, "enabled" | "consumed" | "nextRunAt">;
  onClose: () => void;
  onSave: (value: ScheduleDefinition) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [onceAt, setOnceAt] = useState(
    localDateTime(
      initial.timing.type === "once" ? initial.timing.at : Date.now() + 3600000,
    ),
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty =
    JSON.stringify(value) !== JSON.stringify(initial) ||
    (initial.timing.type === "once" &&
      onceAt !== localDateTime(initial.timing.at));
  const timing = value.timing;
  const setTiming = (timing: ScheduleTiming) => setValue({ ...value, timing });
  const setKind = (type: ScheduleTiming["type"]) => {
    // Re-selecting the current kind must not reset its fields.
    if (type === timing.type) return;
    setTiming(
      type === "once"
        ? { type: "once", at: new Date(onceAt).getTime() }
        : type === "interval"
          ? { type: "interval", minutes: 60 }
          : defaultSchedule().timing,
    );
  };
  const close = () => {
    if (pending) return;
    if (dirty) {
      setDiscard(true);
      return;
    }
    onClose();
  };
  const candidate: ScheduleTiming =
    timing.type === "once"
      ? {
          type: "once",
          at:
            initial.timing.type === "once" &&
            onceAt === localDateTime(initial.timing.at)
              ? initial.timing.at
              : new Date(onceAt).getTime(),
        }
      : timing;
  const timingChanged = !sameScheduleTiming(candidate, initial.timing);
  const enabledAfterSave =
    !saved ||
    saved.enabled ||
    (saved.consumed && candidate.type === "once" && timingChanged);
  let next: number | null = null;
  try {
    if (enabledAfterSave)
      next =
        saved && !timingChanged
          ? saved.nextRunAt
          : nextScheduledTime(candidate, Date.now());
  } catch {
    /* inline validation on save */
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const definition = validateSchedule({
        ...value,
        timing: candidate,
      });
      if (
        enabledAfterSave &&
        nextScheduledTime(definition.timing, Date.now()) === null
      )
        throw new Error("Choose a date and time in the future.");
      setPending(true);
      await onSave(definition);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save this schedule.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(90dvh,52rem)] sm:max-w-2xl md:max-w-3xl"
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 gap-1.5 border-b px-5 py-4 pr-12 text-left sm:px-6">
          <DialogTitle>
            {editing ? "Edit schedule" : "New schedule"}
          </DialogTitle>
          <DialogDescription>
            Each run starts a new cloud task with your instructions.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
            <fieldset
              disabled={pending}
              className="min-w-0 space-y-5 md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:gap-6 md:space-y-0"
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-name`}>Name</Label>
                  <Input
                    id={`${id}-name`}
                    value={value.name}
                    onChange={(e) =>
                      setValue({ ...value, name: e.target.value })
                    }
                    maxLength={80}
                    placeholder="e.g. Morning security brief"
                    required
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-prompt`}>Instructions</Label>
                  <Textarea
                    id={`${id}-prompt`}
                    value={value.prompt}
                    onChange={(e) =>
                      setValue({ ...value, prompt: e.target.value })
                    }
                    maxLength={16000}
                    rows={4}
                    className="min-h-24 resize-y md:min-h-56"
                    placeholder="What should HackerAI do each time? Include any context it needs."
                    required
                  />
                </div>
              </div>
              <div className="space-y-4">
                <div className="space-y-4 border-t pt-5 md:border-t-0 md:pt-0">
                  <div className="space-y-2">
                    <div
                      id={`${id}-kind`}
                      className="text-sm leading-none font-medium"
                    >
                      When
                    </div>
                    <div
                      role="group"
                      aria-labelledby={`${id}-kind`}
                      className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/40 p-1"
                    >
                      {KINDS.map((kind) => (
                        <button
                          key={kind.value}
                          type="button"
                          aria-pressed={timing.type === kind.value}
                          onClick={() => setKind(kind.value)}
                          className={cn(
                            "h-11 min-w-0 truncate rounded-md px-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-8",
                            timing.type === kind.value
                              ? "bg-background font-medium text-foreground shadow-xs dark:bg-input/60"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {kind.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {timing.type === "interval" && (
                    <div className="space-y-2">
                      <Label htmlFor={`${id}-minutes`}>
                        Repeat every (minutes)
                      </Label>
                      <Input
                        id={`${id}-minutes`}
                        type="number"
                        inputMode="numeric"
                        min={15}
                        max={43200}
                        step={1}
                        className="tabular-nums sm:w-40"
                        value={timing.minutes}
                        onChange={(e) =>
                          setTiming({
                            ...timing,
                            minutes: Number(e.target.value),
                          })
                        }
                        required
                      />
                      <p className="text-sm font-medium">
                        {Number.isFinite(timing.minutes) && timing.minutes >= 15
                          ? describeTiming(timing)
                          : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Minimum 15 minutes. The first run starts after this
                        interval.
                      </p>
                    </div>
                  )}
                  {timing.type === "once" && (
                    <div className="space-y-2">
                      <Label htmlFor={`${id}-at`}>Date and time</Label>
                      <Input
                        id={`${id}-at`}
                        type="datetime-local"
                        className="sm:w-64"
                        value={onceAt}
                        onInput={(e) => setOnceAt(e.currentTarget.value)}
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        Your current time zone:{" "}
                        {Intl.DateTimeFormat().resolvedOptions().timeZone}
                      </p>
                    </div>
                  )}
                  {timing.type === "weekly" && (
                    <>
                      <div className="space-y-2">
                        <div
                          id={`${id}-days`}
                          className="text-sm leading-none font-medium"
                        >
                          Days
                        </div>
                        <div
                          className="grid grid-cols-7 gap-1"
                          role="group"
                          aria-labelledby={`${id}-days`}
                        >
                          {DISPLAY_DAYS.map((day) => (
                            <Button
                              key={day}
                              type="button"
                              variant="outline"
                              size="sm"
                              className={cn(
                                "h-11 min-w-0 flex-col gap-0 px-0 text-xs sm:h-10",
                                timing.weekdays.includes(day)
                                  ? "border-foreground/50 bg-foreground/15 font-medium text-foreground dark:bg-foreground/15"
                                  : "bg-transparent text-muted-foreground dark:bg-transparent",
                              )}
                              aria-label={DAYS[day]}
                              aria-pressed={timing.weekdays.includes(day)}
                              onClick={() =>
                                setTiming({
                                  ...timing,
                                  weekdays: timing.weekdays.includes(day)
                                    ? timing.weekdays.filter((d) => d !== day)
                                    : [...timing.weekdays, day].sort(),
                                })
                              }
                            >
                              {DAYS[day].slice(0, 3)}
                              <Check
                                className={cn(
                                  "size-3",
                                  !timing.weekdays.includes(day) && "invisible",
                                )}
                                aria-hidden="true"
                              />
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="grid gap-3 min-[380px]:grid-cols-[minmax(0,8.25rem)_minmax(0,1fr)] sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
                        <div className="min-w-0 space-y-2">
                          <Label htmlFor={`${id}-time`}>Time</Label>
                          <Input
                            id={`${id}-time`}
                            type="time"
                            className="min-w-0 px-2 tabular-nums"
                            value={timing.time}
                            onInput={(e) =>
                              setTiming({
                                ...timing,
                                time: e.currentTarget.value,
                              })
                            }
                            required
                          />
                        </div>
                        <div className="min-w-0 space-y-2">
                          <Label htmlFor={`${id}-timezone`}>Time zone</Label>
                          <Input
                            id={`${id}-timezone`}
                            value={timing.timezone}
                            onChange={(e) =>
                              setTiming({ ...timing, timezone: e.target.value })
                            }
                            placeholder="America/Chicago"
                            list={`${id}-zones`}
                            autoComplete="off"
                            spellCheck={false}
                            required
                          />
                          <datalist id={`${id}-zones`}>
                            {[
                              ...new Set([
                                Intl.DateTimeFormat().resolvedOptions()
                                  .timeZone,
                                "UTC",
                                "America/New_York",
                                "America/Chicago",
                                "America/Denver",
                                "America/Los_Angeles",
                                "Europe/London",
                                "Europe/Berlin",
                                "Asia/Kolkata",
                                "Asia/Tokyo",
                                "Australia/Sydney",
                              ]),
                            ].map((z) => (
                              <option key={z} value={z} />
                            ))}
                          </datalist>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <CalendarClock
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {next ? (
                    <p>
                      Next run:{" "}
                      <span className="font-medium text-foreground tabular-nums">
                        {new Date(next).toLocaleString([], {
                          dateStyle: "medium",
                          timeStyle: "short",
                          ...(timing.type === "weekly"
                            ? { timeZone: timing.timezone }
                            : {}),
                        })}
                      </span>
                      {timing.type === "weekly" ? ` · ${timing.timezone}` : ""}.
                    </p>
                  ) : !enabledAfterSave ? (
                    <p>
                      {saved?.consumed && !timingChanged
                        ? "This one-time schedule already ran. Choose a new date and time to run it again."
                        : "This schedule will stay paused after saving. Resume it from the schedule menu to set its next run."}
                    </p>
                  ) : (
                    <p>
                      {timing.type === "once"
                        ? "Choose a date and time in the future to see when it runs."
                        : "Finish choosing when to run to see the next run time."}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <Label htmlFor={`${id}-model`}>Model</Label>
                  <Select
                    value={value.model}
                    onValueChange={(model) =>
                      setValue({
                        ...value,
                        model: model as ScheduleDefinition["model"],
                      })
                    }
                  >
                    <SelectTrigger
                      id={`${id}-model`}
                      className="w-full sm:w-52"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Auto</SelectItem>
                      <SelectItem value="pro">HackerAI Pro</SelectItem>
                      <SelectItem value="max">HackerAI Max</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </fieldset>
            <div
              aria-hidden="true"
              className="pointer-events-none sticky bottom-0 -mx-5 -mb-4 h-6 bg-gradient-to-t from-background sm:-mx-6"
            />
          </div>
          <div className="shrink-0 space-y-3 border-t bg-muted/20 px-5 py-3 sm:px-6">
            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <div className="flex items-start gap-2">
                <Cloud
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <p>
                  <span className="font-medium text-foreground">
                    Runs in your cloud workspace.
                  </span>{" "}
                  Saving authorizes HackerAI to run these instructions with full
                  tool access, even while you’re away. Runs use your account’s
                  normal usage and spending limits.
                </p>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="h-11 sm:h-9"
                onClick={close}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                {pending
                  ? "Saving…"
                  : editing
                    ? "Save changes"
                    : "Create schedule"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader className="text-left">
            <AlertDialogTitle>Discard your unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {editing
                ? "Your edits will be lost. The saved schedule will stay as it is."
                : "Your instructions and timing will be lost. No schedule will be created."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col">
            <AlertDialogAction
              onClick={onClose}
              className="h-11 border border-destructive/30 bg-transparent text-destructive shadow-none hover:bg-destructive/10 sm:h-9"
            >
              Discard changes
            </AlertDialogAction>
            <AlertDialogCancel className="h-11 border-transparent bg-primary-foreground text-primary hover:bg-primary-foreground hover:text-primary hover:opacity-90 dark:border-transparent dark:bg-primary-foreground dark:hover:bg-primary-foreground sm:h-9">
              Keep editing
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
