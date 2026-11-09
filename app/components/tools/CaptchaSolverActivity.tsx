"use client";
import { useEffect, useState } from "react";
import { LoaderCircle, Puzzle } from "lucide-react";
import ToolBlock from "@/components/ui/tool-block";
import {
  formatCaptchaElapsed,
  getCaptchaActivityLabel,
  type CaptchaActivity,
} from "./captcha-tool-utils";

export function CaptchaSolverActivity({
  activity,
  command,
  compact = false,
  onClick,
  onKeyDown,
}: {
  activity: CaptchaActivity;
  command: string;
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
    solving: "Waiting for the solver response. Time varies by challenge.",
    response_delivered:
      "The response reached the page. Website acceptance is checked separately.",
    needs_verification:
      "Automatic solving could not finish verification. Check the Agent’s result before continuing.",
    failed:
      "The solve could not finish. Check the Agent’s result for the next step.",
    stopped:
      "The Agent stopped this request. Check its result for any provider cost.",
    unavailable: "Automatic solving is unavailable for this request.",
    preparation_required:
      "The browser needs preparation before a paid solve can start.",
    not_needed: "The page no longer reports a pending challenge.",
  }[activity.state];
  return (
    <section
      aria-label="CAPTCHA solver"
      className="p-4 text-sm text-foreground"
    >
      <div className="rounded-[15px] border border-border bg-muted/20 p-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4"
            aria-hidden="true"
          >
            {icon}
          </span>
          <span role="status" className="min-w-0 flex-1 font-medium">
            {label}
          </span>
          {elapsed !== undefined && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatCaptchaElapsed(elapsed)} elapsed
            </span>
          )}
        </div>
        <p className="mt-3 text-[13px] leading-5 text-muted-foreground">
          {detail}
        </p>
        <details className="mt-4 border-t border-border pt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Command details
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
            {command}
          </pre>
        </details>
      </div>
    </section>
  );
}
