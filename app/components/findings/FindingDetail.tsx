"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ExternalLink, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { FindingDetailRecord } from "@/types/finding";
import { cn } from "@/lib/utils";
import { getFindingSeverityClasses } from "./FindingCard";

const DetailSection = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {title}
    </h3>
    <div className="text-sm text-foreground">{children}</div>
  </section>
);

const MarkdownSection = ({
  title,
  value,
}: {
  title: string;
  value: string;
}) => (
  <DetailSection title={title}>
    <MemoizedMarkdown content={value} />
  </DetailSection>
);

export function FindingDetail({
  findingId,
  finding: suppliedFinding,
  onDeleted,
  surface = "detail",
  className,
}: {
  findingId?: string;
  finding?: FindingDetailRecord | null;
  onDeleted?: () => void;
  surface?: "computer_sidebar" | "findings_page" | "detail";
  className?: string;
}) {
  const queriedFinding = useQuery(
    api.findings.getFinding,
    suppliedFinding !== undefined || !findingId ? "skip" : { findingId },
  ) as FindingDetailRecord | null | undefined;
  const deleteFinding = useMutation(api.findings.deleteFinding);
  const [isDeleting, setIsDeleting] = useState(false);
  const finding =
    suppliedFinding !== undefined ? suppliedFinding : queriedFinding;

  if (finding === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Loading finding…
      </div>
    );
  }

  if (!finding) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <ShieldAlert className="size-8 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">Finding deleted</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This structured finding is no longer available.
          </p>
        </div>
      </div>
    );
  }

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const result = await deleteFinding({ findingId: finding.finding_id });
      if (result.deleted) {
        captureAuthenticatedEvent("finding_deleted", { surface });
        toast.success("Finding deleted");
        onDeleted?.();
      }
    } catch {
      toast.error("Could not delete finding");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className={cn("h-full overflow-y-auto", className)}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-semibold uppercase",
                getFindingSeverityClasses(finding.severity),
              )}
            >
              {finding.severity}
            </span>
            <span className="rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-xs text-foreground">
              CVSS {finding.cvss_score.toFixed(1)}
            </span>
            {finding.cve && (
              <span className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground">
                {finding.cve}
              </span>
            )}
            {finding.cwe && (
              <span className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground">
                {finding.cwe}
              </span>
            )}
          </div>
          <h2 className="text-xl font-semibold leading-tight text-foreground sm:text-2xl">
            {finding.title}
          </h2>
          <div className="space-y-1 font-mono text-xs text-muted-foreground">
            <div className="break-all">{finding.target}</div>
            {finding.endpoint && (
              <div className="break-all">
                {finding.method ? `${finding.method} ` : ""}
                {finding.endpoint}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <Link
              href={`/c/${finding.chat_id}`}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              {finding.chat_title}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={isDeleting}>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this finding?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the report and removes its card
                    from the source assistant message.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void handleDelete()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete finding
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <MarkdownSection title="Description" value={finding.description} />
        <MarkdownSection title="Impact" value={finding.impact} />
        <MarkdownSection
          title="Technical analysis"
          value={finding.technical_analysis}
        />
        <MarkdownSection
          title="Proof of concept"
          value={finding.poc_description}
        />
        <DetailSection title="PoC script / payload">
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed">
            <code>{finding.poc_script_code}</code>
          </pre>
        </DetailSection>
        <MarkdownSection title="Evidence" value={finding.evidence} />
        <MarkdownSection title="Assumptions" value={finding.assumptions} />
        <MarkdownSection
          title="Remediation"
          value={finding.remediation_steps}
        />

        {finding.code_locations && finding.code_locations.length > 0 && (
          <DetailSection title="Code locations">
            <div className="space-y-3">
              {finding.code_locations.map((location, index) => (
                <div
                  key={`${location.file}:${location.start_line}:${index}`}
                  className="rounded-lg border border-border bg-muted/20 p-3"
                >
                  <div className="font-mono text-xs text-foreground">
                    {location.file}:{location.start_line}-{location.end_line}
                  </div>
                  {location.label && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {location.label}
                    </div>
                  )}
                  {location.snippet && (
                    <pre className="mt-3 overflow-x-auto rounded-md bg-background p-3 text-xs">
                      <code>{location.snippet}</code>
                    </pre>
                  )}
                  {location.fix_before && location.fix_after && (
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                          Before
                        </div>
                        <pre className="overflow-x-auto rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs">
                          <code>{location.fix_before}</code>
                        </pre>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                          After
                        </div>
                        <pre className="overflow-x-auto rounded-md border border-green-500/20 bg-green-500/5 p-3 text-xs">
                          <code>{location.fix_after}</code>
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </DetailSection>
        )}

        <DetailSection title="Scoring">
          <div className="space-y-1 rounded-lg border border-border bg-muted/20 p-3 font-mono text-xs text-muted-foreground">
            <div>{finding.cvss_vector}</div>
            <div>Fix effort: {finding.fix_effort}</div>
          </div>
        </DetailSection>
      </div>
    </div>
  );
}
