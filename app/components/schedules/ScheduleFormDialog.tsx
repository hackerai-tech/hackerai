"use client";
import { useId, useState } from "react";
import { CalendarClock, Cloud, Loader2 } from "lucide-react";
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
  validateSchedule,
  type ScheduleDefinition,
  type ScheduleTiming,
} from "@/lib/schedules/recurrence";

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
  onClose,
  onSave,
}: {
  initial: ScheduleDefinition;
  editing: boolean;
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
  const close = () => {
    if (pending) return;
    if (dirty) {
      setDiscard(true);
      return;
    }
    onClose();
  };
  let next: number | null = null;
  try {
    next = nextScheduledTime(
      timing.type === "once"
        ? { type: "once", at: new Date(onceAt).getTime() }
        : timing,
      Date.now(),
    );
  } catch {
    /* inline validation on save */
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const definition = validateSchedule({
        ...value,
        timing:
          timing.type === "once"
            ? { type: "once", at: new Date(onceAt).getTime() }
            : timing,
      });
      if (nextScheduledTime(definition.timing, Date.now()) === null)
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
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-5" />
            {editing ? "Edit schedule" : "New schedule"}
          </DialogTitle>
          <DialogDescription>
            Give HackerAI a prompt and a time. Come back to the result.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <fieldset disabled={pending} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
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
                onChange={(e) => setValue({ ...value, prompt: e.target.value })}
                maxLength={16000}
                rows={5}
                className="min-h-28 resize-y"
                placeholder="What should HackerAI do each time? Include any context it needs."
                required
              />
              <p className="text-xs text-muted-foreground">
                Each run starts a new task with these instructions.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-kind`}>When</Label>
              <Select
                value={timing.type}
                onValueChange={(type) =>
                  setTiming(
                    type === "once"
                      ? { type: "once", at: new Date(onceAt).getTime() }
                      : type === "interval"
                        ? { type: "interval", minutes: 60 }
                        : defaultSchedule().timing,
                  )
                }
              >
                <SelectTrigger id={`${id}-kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">At a set time</SelectItem>
                  <SelectItem value="interval">At an interval</SelectItem>
                  <SelectItem value="once">One time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {timing.type === "interval" && (
              <div className="space-y-2">
                <Label htmlFor={`${id}-minutes`}>Repeat every (minutes)</Label>
                <Input
                  id={`${id}-minutes`}
                  type="number"
                  min={15}
                  max={43200}
                  step={1}
                  value={timing.minutes}
                  onChange={(e) =>
                    setTiming({ ...timing, minutes: Number(e.target.value) })
                  }
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Minimum 15 minutes. The first run starts after this interval.
                </p>
              </div>
            )}
            {timing.type === "once" && (
              <div className="space-y-2">
                <Label htmlFor={`${id}-at`}>Date and time</Label>
                <Input
                  id={`${id}-at`}
                  type="datetime-local"
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
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Days</Label>
                  <div
                    className="flex flex-wrap gap-1.5"
                    role="group"
                    aria-label="Days of the week"
                  >
                    {DISPLAY_DAYS.map((day) => (
                      <Button
                        key={day}
                        type="button"
                        variant={
                          timing.weekdays.includes(day) ? "default" : "outline"
                        }
                        size="sm"
                        className="size-9 p-0"
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
                        {DAYS[day].slice(0, 1)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-time`}>Time</Label>
                    <Input
                      id={`${id}-time`}
                      type="time"
                      value={timing.time}
                      onInput={(e) =>
                        setTiming({ ...timing, time: e.currentTarget.value })
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-timezone`}>Time zone</Label>
                    <Input
                      id={`${id}-timezone`}
                      value={timing.timezone}
                      onChange={(e) =>
                        setTiming({ ...timing, timezone: e.target.value })
                      }
                      placeholder="America/Chicago"
                      list={`${id}-zones`}
                      required
                    />
                    <datalist id={`${id}-zones`}>
                      {[
                        ...new Set([
                          Intl.DateTimeFormat().resolvedOptions().timeZone,
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
              </div>
            )}
            <div className="space-y-2">
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
                <SelectTrigger id={`${id}-model`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Auto</SelectItem>
                  <SelectItem value="pro">HackerAI Pro</SelectItem>
                  <SelectItem value="max">HackerAI Max</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </fieldset>
          <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <Cloud className="size-3.5" /> Runs in your cloud workspace
            </p>
            Saving authorizes HackerAI to run these instructions with full tool
            access, even while you’re away. Runs use your account’s normal usage
            and spending limits.
          </div>
          {next && (
            <p className="text-xs text-muted-foreground">
              Next run:{" "}
              <span className="font-medium text-foreground">
                {new Date(next).toLocaleString([], {
                  dateStyle: "medium",
                  timeStyle: "short",
                  ...(timing.type === "weekly"
                    ? { timeZone: timing.timezone }
                    : {}),
                })}
              </span>
              {timing.type === "weekly" ? ` · ${timing.timezone}` : ""}. Starts
              within about a minute of the scheduled time.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {pending
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Create schedule"}
            </Button>
          </div>
        </form>
      </DialogContent>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits will be lost. The saved schedule will stay as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
