import Link from "next/link";
import type { FindingDetailRecord } from "@/types/finding";
import { getSourceMessageHref } from "@/lib/findings/source-message";

export function FindingHistory({ finding }: { finding: FindingDetailRecord }) {
  if (!finding.correction_history?.length) return null;
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        Correction history (
        {finding.correction_count ?? finding.correction_history.length})
      </summary>
      <p className="mt-3 text-xs text-muted-foreground">
        Latest {finding.correction_history.length} corrections. Earlier report
        content is not retained here.
      </p>
      <ol className="mt-4 space-y-4">
        {[...finding.correction_history].reverse().map((revision) => (
          <li
            key={revision.updated_at}
            className="space-y-2 border-t border-border pt-3 text-sm"
          >
            <p className="whitespace-pre-wrap break-words">{revision.reason}</p>
            <p className="text-xs text-muted-foreground">
              Changed:{" "}
              {revision.changed_fields
                .map((field) => field.replaceAll("_", " "))
                .join(", ") || "No report fields changed"}
            </p>
            <p className="text-xs">
              Severity: {revision.previous_severity} (
              {revision.previous_cvss_score}) → {revision.severity} (
              {revision.cvss_score}). Confidence:{" "}
              {revision.previous_confidence ?? "Not recorded"} →{" "}
              {revision.confidence ?? "Not recorded"}.
            </p>
            <Link
              className="text-xs underline"
              href={getSourceMessageHref(finding.chat_id, revision.message_id)}
            >
              View correction message
            </Link>
            <time
              className="ml-3 text-xs text-muted-foreground"
              dateTime={new Date(revision.updated_at).toISOString()}
            >
              {new Date(revision.updated_at).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
    </details>
  );
}
