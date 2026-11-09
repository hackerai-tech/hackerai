"use client";
import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Puzzle } from "lucide-react";
import ToolBlock from "@/components/ui/tool-block";
import {
  formatCaptchaElapsed,
  getCaptchaActivityLabel,
  type CaptchaActivity,
} from "./captcha-tool-utils";

export function CaptchaSolverActivity({
  activity,
  compact = false,
  onClick,
  onKeyDown,
}: {
  activity: CaptchaActivity;
  compact?: boolean;
  onClick?: () => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
}) {
  const [now, setNow] = useState<number>();
  const active = activity.state === "solving";
  useEffect(() => {
    if (!active || activity.startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, activity.startedAt]);
  const elapsed =
    activity.elapsedMs ??
    (active && activity.startedAt !== undefined && now !== undefined
      ? Math.max(0, now - activity.startedAt)
      : undefined);
  const label = getCaptchaActivityLabel(activity.state);
  const icon = active ? (
    <LoaderCircle className="animate-spin motion-reduce:animate-none" />
  ) : (
    <Puzzle />
  );
  if (compact)
    return (
      <ToolBlock
        icon={icon}
        action={label}
        target={
          elapsed === undefined
            ? undefined
            : `${formatCaptchaElapsed(elapsed)} elapsed`
        }
        isClickable={!!onClick}
        onClick={onClick}
        onKeyDown={onKeyDown}
        accessibleLabel={`Open CAPTCHA solver details: ${label}`}
      />
    );
  const detail = {
    solving: undefined,
    response_delivered: "Website acceptance is checked separately.",
    needs_verification:
      "Automatic solving could not finish. Manual verification may be needed.",
    failed: "The solve could not finish. See the Agent’s reply.",
    stopped: "A provider charge may still apply. Check the Agent’s recap.",
    unavailable: "Automatic solving is unavailable for this request.",
    preparation_required: "Close the open challenge before solving.",
    not_needed: undefined,
  }[activity.state];
  return (
    <section
      aria-label="CAPTCHA solver"
      className="whitespace-normal px-3 py-3 font-sans text-sm text-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:h-4 [&>svg]:w-4"
          aria-hidden="true"
        >
          {active ? (
            icon
          ) : activity.state === "failed" ||
            activity.state === "needs_verification" ? (
            <CircleAlert />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          )}
        </span>
        <span role="status" className="min-w-0 truncate font-medium">
          {label}
        </span>
        {elapsed !== undefined && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            · {formatCaptchaElapsed(elapsed)}
            <span className="sr-only"> elapsed</span>
          </span>
        )}
      </div>
      {detail && (
        <p className="mt-1 pl-6 text-[13px] leading-5 text-muted-foreground">
          {detail}
        </p>
      )}
    </section>
  );
}
