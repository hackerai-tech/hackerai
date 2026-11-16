import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useId } from "react";
import type { FindingDetailRecord } from "@/types/finding";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import { FindingDiscoveredAt } from "./FindingTime";

/**
 * Runs of the source schedule that reported this finding, newest first.
 * Collapsed by default and limited to the runs the server returns, while the
 * count covers all of them. A repeat report is not a retest: it changes
 * neither the saved evidence nor the status, and this says so.
 */
export function ScheduledFindingHistory({
  finding,
}: {
  finding: FindingDetailRecord;
}) {
  const id = useId();
  const runs = finding.scheduledObservations ?? [];
  const total = Math.max(finding.observationCount ?? 0, runs.length);
  // A single run is the source task, already named in the report details.
  if (total < 2 || runs.length === 0) return null;
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        Reported by {total} scheduled runs
      </summary>
      <p className="mt-3 text-xs text-muted-foreground">
        {runs.length < total
          ? `Latest ${runs.length} of ${total} runs. `
          : null}
        Repeat reports don’t change this report’s evidence or status.
      </p>
      <ol className="mt-3 divide-y divide-border border-t border-border text-sm">
        {runs.map((run, index) => {
          const timeId = `${id}-run-${index}`;
          const linkId = `${id}-task-${index}`;
          return (
            <li
              key={`${run.observedAt}:${index}`}
              className="flex min-h-11 items-center justify-between gap-3 py-1.5"
            >
              <span id={timeId} className="min-w-0 tabular-nums">
                <FindingDiscoveredAt timestamp={run.observedAt} />
              </span>
              {run.taskAvailable && run.chatId && run.messageId ? (
                <Link
                  id={linkId}
                  href={getSourceMessageHref(run.chatId, run.messageId)}
                  // Each link is named by its own run time.
                  aria-labelledby={`${linkId} ${timeId}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded text-xs font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Open task
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Link>
              ) : run.taskAvailable ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Task deleted
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
