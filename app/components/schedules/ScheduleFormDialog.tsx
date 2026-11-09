"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  CircleAlert,
  Cloud,
  Laptop,
  Loader2,
  Monitor,
  Shield,
  WifiOff,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isDesktopPreference } from "@/lib/sandbox/environment";
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
const CLOUD = "cloud";
// validateLocalScheduleExecution owns the path rules; this is the message it
// uses for a bad folder, so that error can be shown at the folder field.
const FOLDER_ERROR = "Enter an absolute folder path.";
type ScheduleComputer = { preference: string; name: string };
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
  computers,
  onClose,
  onSave,
}: {
  initial: ScheduleDefinition;
  editing: boolean;
  saved?: Pick<AgentSchedule, "enabled" | "consumed" | "nextRunAt">;
  computers: ScheduleComputer[];
  onClose: () => void;
  onSave: (value: ScheduleDefinition) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const folders = useRef<Record<string, string>>(
    initial.execution
      ? { [initial.execution.preference]: initial.execution.workingDirectory }
      : {},
  );
  const [folderError, setFolderError] = useState("");
  const execution = value.execution;
  const listed = (preference: string) =>
    computers.some((computer) => computer.preference === preference);
  // A saved or selected computer stays choosable after it leaves the list.
  const unlisted = [initial.execution, execution].flatMap((target) =>
    target && !listed(target.preference) ? [target] : [],
  );
  const targets = [
    ...computers.map((computer) => ({ ...computer, unavailable: false })),
    ...unlisted
      .filter(
        (target, index) =>
          unlisted.findIndex((t) => t.preference === target.preference) ===
          index,
      )
      .map(({ preference, name }) => ({ preference, name, unavailable: true })),
  ];
  const unavailable = Boolean(execution && !listed(execution.preference));
  const ExecutionIcon = !execution
    ? Cloud
    : isDesktopPreference(execution.preference)
      ? Monitor
      : Laptop;
  const setRunOn = (preference: string) => {
    if (preference === (execution?.preference ?? CLOUD)) return;
    const target = targets.find((t) => t.preference === preference);
    setFolderError("");
    setValue({
      ...value,
      execution: target && {
        type: "local",
        preference: target.preference,
        name: target.name,
        workingDirectory: folders.current[target.preference] ?? "",
      },
    });
  };
  const [onceAt, setOnceAt] = useState(() =>
    localDateTime(
      initial.timing.type === "once" ? initial.timing.at : Date.now() + 3600000,
    ),
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (folderError && !pending)
      document.getElementById(`${id}-folder`)?.focus();
  }, [folderError, pending, id]);
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
          : nextScheduledTime(candidate, now);
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
      const message =
        e instanceof Error ? e.message : "Could not save this schedule.";
      if (execution && message === FOLDER_ERROR) {
        setFolderError(message);
        document.getElementById(`${id}-folder`)?.focus();
      } else setError(message);
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
        showCloseButton={false}
        className="flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-auto sm:max-h-[min(92dvh,56rem)] sm:max-w-[calc(100%-2rem)] sm:rounded-lg sm:border md:max-w-2xl lg:max-w-[min(calc(100%-4rem),68rem)]"
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader className="min-h-14 shrink-0 flex-row items-center gap-3 border-b py-2.5 pr-14 pl-4 text-left sm:py-4 sm:pl-6 lg:pl-8">
          <div className="min-w-0 flex-1 space-y-1">
            <DialogTitle className="text-lg tracking-tight lg:text-xl">
              {editing ? "Edit schedule" : "New schedule"}
            </DialogTitle>
            <DialogDescription className="max-sm:sr-only">
              Each run starts a new task with your instructions.
            </DialogDescription>
          </div>
          {dirty && (
            <span className="shrink-0 text-xs text-muted-foreground">
              Unsaved<span className="max-sm:hidden"> changes</span>
            </span>
          )}
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <fieldset
              disabled={pending}
              className="min-w-0 lg:grid lg:min-h-full lg:grid-cols-[minmax(0,1fr)_22rem]"
            >
              <div className="space-y-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-name`}>Name</Label>
                  <Input
                    id={`${id}-name`}
                    value={value.name}
                    onChange={(e) =>
                      setValue({ ...value, name: e.target.value })
                    }
                    maxLength={80}
                    className="h-11 lg:h-12 lg:text-lg lg:font-medium"
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
                    rows={6}
                    aria-describedby={`${id}-prompt-help`}
                    className="min-h-32 resize-y leading-relaxed lg:min-h-52"
                    placeholder="What should HackerAI do each time? Include any context it needs."
                    required
                  />
                  <p
                    id={`${id}-prompt-help`}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    Each run starts a new task with these instructions. Say
                    exactly what to touch and what to report.
                  </p>
                </div>
                <div
                  className={cn(
                    "grid gap-6",
                    execution && "md:grid-cols-2 md:gap-5",
                  )}
                >
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor={`${id}-run-on`}>Run on</Label>
                    <Select
                      value={execution?.preference ?? CLOUD}
                      onValueChange={setRunOn}
                    >
                      <SelectTrigger
                        id={`${id}-run-on`}
                        aria-describedby={`${id}-run-on-help`}
                        className="h-auto min-h-11 w-full items-start gap-2 py-2.5 text-left whitespace-normal sm:min-h-9 sm:py-2 [&>span]:min-w-0 [&>span]:flex-1 [&>span]:line-clamp-none [&>svg]:mt-0.5 [&>svg]:shrink-0"
                      >
                        <SelectValue>
                          <span className="flex min-w-0 items-start gap-2">
                            <ExecutionIcon
                              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <span className="min-w-0">
                              <span
                                className="line-clamp-2 wrap-anywhere"
                                title={execution?.name}
                              >
                                {execution?.name ?? "Cloud"}
                              </span>
                              {unavailable && (
                                <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-500">
                                  <WifiOff
                                    className="size-3 shrink-0"
                                    aria-hidden="true"
                                  />
                                  Unavailable
                                </span>
                              )}
                            </span>
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="max-h-[min(22rem,var(--radix-select-content-available-height))] max-w-[min(28rem,var(--radix-select-content-available-width))]">
                        <SelectItem value={CLOUD} className="py-2.5 sm:py-1.5">
                          <Cloud
                            className="mr-2 inline size-4 align-[-3px] text-muted-foreground"
                            aria-hidden="true"
                          />
                          Cloud
                        </SelectItem>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel className="text-xs font-medium text-muted-foreground">
                            Your computers
                          </SelectLabel>
                          {targets.length ? (
                            targets.map((target) => {
                              const Icon = isDesktopPreference(
                                target.preference,
                              )
                                ? Monitor
                                : Laptop;
                              return (
                                <SelectItem
                                  key={target.preference}
                                  value={target.preference}
                                  className="py-2.5 wrap-anywhere sm:py-1.5"
                                >
                                  <Icon
                                    className="mr-2 inline size-4 align-[-3px] text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                  {target.name}
                                  {target.unavailable && (
                                    <span className="text-muted-foreground">
                                      {" "}
                                      · Unavailable
                                    </span>
                                  )}
                                </SelectItem>
                              );
                            })
                          ) : (
                            <SelectItem value="none" disabled>
                              No computers connected
                            </SelectItem>
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <p
                      id={`${id}-run-on-help`}
                      className={cn(
                        "flex items-start gap-1.5 text-xs leading-relaxed",
                        unavailable
                          ? "text-amber-700 dark:text-amber-500"
                          : "text-muted-foreground",
                      )}
                    >
                      {unavailable && (
                        <WifiOff
                          className="mt-0.5 size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <span className="min-w-0 break-words">
                        {!execution
                          ? `Runs in your cloud workspace while you’re away.${
                              targets.length
                                ? ""
                                : " Connect a computer to run schedules on it."
                            }`
                          : unavailable
                            ? "The selected computer is unavailable. You can still save changes; runs are skipped until it reconnects and never move to the cloud."
                            : "Runs only while the selected computer is awake and connected. Missed runs are skipped, never made up later or moved to the cloud."}
                      </span>
                    </p>
                  </div>
                  {execution && (
                    <div className="min-w-0 space-y-2">
                      <Label htmlFor={`${id}-folder`}>Starting folder</Label>
                      <Input
                        id={`${id}-folder`}
                        value={execution.workingDirectory}
                        onChange={(e) => {
                          folders.current[execution.preference] =
                            e.target.value;
                          setFolderError("");
                          setValue({
                            ...value,
                            execution: {
                              ...execution,
                              workingDirectory: e.target.value,
                            },
                          });
                        }}
                        maxLength={4096}
                        className="h-11 font-mono sm:h-9"
                        placeholder="/home/you/project"
                        aria-invalid={folderError ? true : undefined}
                        aria-describedby={
                          folderError
                            ? `${id}-folder-error ${id}-folder-help`
                            : `${id}-folder-help`
                        }
                        autoCapitalize="none"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                        required
                      />
                      {folderError && (
                        <p
                          id={`${id}-folder-error`}
                          role="alert"
                          className="flex items-start gap-1.5 text-xs leading-relaxed text-destructive"
                        >
                          <CircleAlert
                            className="mt-0.5 size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          {folderError}
                        </p>
                      )}
                      <p
                        id={`${id}-folder-help`}
                        className="text-xs leading-relaxed wrap-anywhere text-muted-foreground"
                      >
                        Absolute path where each task starts, such as{" "}
                        <code className="font-mono">/home/you/project</code>,{" "}
                        <code className="font-mono">C:\Users\you\project</code>{" "}
                        or{" "}
                        <code className="font-mono">
                          \\server\share\project
                        </code>
                        . It’s a starting point, not a boundary: tools can reach
                        anything the selected computer can.
                      </p>
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-6 border-t bg-muted/30 px-4 py-5 sm:px-6 lg:border-t-0 lg:border-l lg:py-6">
                <div className="space-y-4">
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
                        className="h-11 tabular-nums sm:h-9 sm:w-40"
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
                        className="h-11 min-w-0 max-w-full sm:h-9 sm:w-64 lg:w-full"
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
                                "h-11 min-w-0 px-0 text-xs sm:h-9",
                                timing.weekdays.includes(day)
                                  ? "border-foreground bg-foreground font-medium text-background hover:bg-foreground/90 hover:text-background dark:border-foreground dark:bg-foreground dark:hover:bg-foreground/90"
                                  : "bg-background text-muted-foreground dark:bg-transparent",
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
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="grid gap-3 min-[400px]:grid-cols-[minmax(0,8.25rem)_minmax(0,1fr)] sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
                        <div className="min-w-0 space-y-2">
                          <Label htmlFor={`${id}-time`}>Time</Label>
                          <Input
                            id={`${id}-time`}
                            type="time"
                            className="h-11 min-w-0 px-2 tabular-nums sm:h-9"
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
                            className="h-11 sm:h-9"
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
                <div className="space-y-1.5 border-t pt-5 text-sm leading-relaxed text-muted-foreground">
                  {next ? (
                    <>
                      <p className="text-xs">
                        Next run:
                        <span className="mt-1 block text-lg leading-snug font-semibold tracking-tight text-foreground tabular-nums">
                          {new Date(next).toLocaleString([], {
                            dateStyle: "medium",
                            timeStyle: "short",
                            ...(timing.type === "weekly"
                              ? { timeZone: timing.timezone }
                              : {}),
                          })}
                        </span>
                      </p>
                      {timing.type === "weekly" && (
                        <p className="break-words">
                          {timing.timezone.replaceAll("_", " ")}
                        </p>
                      )}
                      {unavailable && (
                        <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-500">
                          <WifiOff
                            className="mt-1 size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          Skipped if the computer is still unavailable then.
                        </p>
                      )}
                    </>
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
                <div className="space-y-2 border-t pt-5">
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
                      className="h-11 w-full sm:h-9"
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
          </div>
          <div className="shrink-0 space-y-3 border-t bg-background px-4 py-3 sm:px-6 sm:py-4 lg:px-8">
            {error && (
              <p
                role="alert"
                className="flex items-start gap-1.5 text-sm text-destructive"
              >
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words">{error}</span>
              </p>
            )}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-8">
              <div className="flex min-w-0 flex-1 items-start gap-2 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                <Shield
                  className="mt-0.5 size-3.5 shrink-0 max-sm:hidden sm:size-4"
                  aria-hidden="true"
                />
                {execution ? (
                  <p className="min-w-0 break-words">
                    <span className="font-medium text-foreground">
                      Saving lets HackerAI run these instructions unattended on{" "}
                      <span className="wrap-anywhere max-sm:hidden">
                        {execution.name}
                      </span>
                      <span className="sm:hidden">the selected computer</span>{" "}
                      with full tool access.
                    </span>{" "}
                    Access isn’t limited to the starting folder. Normal usage
                    and spending limits apply.
                  </p>
                ) : (
                  <p className="min-w-0">
                    <span className="font-medium text-foreground">
                      Saving lets HackerAI run these instructions unattended in
                      your cloud workspace with full tool access,
                    </span>{" "}
                    including while you’re away. Normal usage and spending
                    limits apply.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end lg:shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 sm:h-9"
                  onClick={close}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="h-11 sm:h-9"
                  disabled={pending}
                >
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  {pending
                    ? "Saving…"
                    : editing
                      ? "Save changes"
                      : "Create schedule"}
                </Button>
              </div>
            </div>
          </div>
        </form>
        {/* After the form so the name field keeps initial focus. */}
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1.5 right-2 size-11 text-muted-foreground sm:top-4 sm:right-4 sm:size-9"
            disabled={pending}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </DialogClose>
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
