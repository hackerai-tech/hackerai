"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  CheckCircle2,
  Clock3,
  Code2,
  Copy,
  MessageSquareText,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
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
import type { Cvss31Breakdown, FindingDetailRecord } from "@/types/finding";
import { cn } from "@/lib/utils";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import { getFindingSeverityClasses } from "./FindingCard";
import { FindingDiscoveredAt } from "./FindingTime";

const CVSS_METRICS: Array<{
  key: keyof Cvss31Breakdown;
  label: string;
}> = [
  { key: "attack_vector", label: "Attack Vector" },
  { key: "attack_complexity", label: "Attack Complexity" },
  { key: "privileges_required", label: "Privileges Required" },
  { key: "user_interaction", label: "User Interaction" },
  { key: "scope", label: "Scope" },
  { key: "confidentiality", label: "Confidentiality" },
  { key: "integrity", label: "Integrity" },
  { key: "availability", label: "Availability" },
];

const CVSS_VALUE_LABELS: Record<
  keyof Cvss31Breakdown,
  Record<string, string>
> = {
  attack_vector: {
    N: "Network",
    A: "Adjacent",
    L: "Local",
    P: "Physical",
  },
  attack_complexity: { L: "Low", H: "High" },
  privileges_required: { N: "None", L: "Low", H: "High" },
  user_interaction: { N: "None", R: "Required" },
  scope: { U: "Unchanged", C: "Changed" },
  confidentiality: { N: "None", L: "Low", H: "High" },
  integrity: { N: "None", L: "Low", H: "High" },
  availability: { N: "None", L: "Low", H: "High" },
};

const formatLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");

const CopyTextButton = ({
  value,
  label,
  successMessage,
}: {
  value: string;
  label: string;
  successMessage: string;
}) => {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error("Could not copy. Try again.");
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8"
      onClick={() => void handleCopy()}
      aria-label={label}
    >
      <Copy className="size-3.5" aria-hidden="true" />
    </Button>
  );
};

const DetailSection = ({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) => (
  <section
    className="space-y-3"
    aria-labelledby={id ? `${id}-heading` : undefined}
  >
    <h4
      id={id ? `${id}-heading` : undefined}
      className="scroll-mt-20 text-sm font-semibold text-foreground"
    >
      {title}
    </h4>
    <div className="min-w-0 break-words text-sm leading-6 text-foreground">
      {children}
    </div>
  </section>
);

const MarkdownSection = ({
  id,
  title,
  value,
}: {
  id?: string;
  title: string;
  value: string;
}) => (
  <DetailSection id={id} title={title}>
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
        <ShieldAlert
          className="size-8 text-muted-foreground"
          aria-hidden="true"
        />
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
      toast.error("Could not delete finding. Try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  const sectionId = (section: string) => `${finding.finding_id}-${section}`;

  return (
    <div
      className={cn(
        "@container h-full overflow-x-hidden overflow-y-auto overscroll-contain",
        className,
      )}
    >
      <article className="mx-auto w-full max-w-5xl p-4 sm:p-6 @min-[760px]:p-8">
        <header className="space-y-4 border-b border-border pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Confirmed
            </span>
            <span
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-semibold uppercase tabular-nums",
                getFindingSeverityClasses(finding.severity),
              )}
            >
              {finding.severity} · {finding.cvss_score.toFixed(1)}
            </span>
            {finding.cwe && (
              <span
                className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground"
                translate="no"
              >
                {finding.cwe}
              </span>
            )}
            {finding.cve && (
              <span
                className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground"
                translate="no"
              >
                {finding.cve}
              </span>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="text-balance text-xl font-semibold leading-tight text-foreground sm:text-2xl">
              {finding.title}
            </h2>
            <div
              className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground"
              translate="no"
            >
              <span className="max-w-full break-all rounded-md bg-muted/50 px-2 py-1">
                {finding.target}
              </span>
              {finding.endpoint && (
                <span className="max-w-full break-all rounded-md bg-muted/50 px-2 py-1">
                  {finding.method ? `${finding.method} ` : ""}
                  {finding.endpoint}
                </span>
              )}
            </div>
          </div>

          {surface === "findings_page" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm">
                <Link
                  href={getSourceMessageHref(
                    finding.chat_id,
                    finding.message_id,
                  )}
                  aria-label={`Open source message in ${finding.chat_title}`}
                >
                  <MessageSquareText className="size-4" aria-hidden="true" />
                  Open source message
                </Link>
              </Button>
              <span className="min-w-0 max-w-56 truncate text-xs text-muted-foreground">
                {finding.chat_title}
              </span>
              <div className="ml-auto">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={isDeleting}>
                      <Trash2 className="size-4" aria-hidden="true" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete This Finding?</AlertDialogTitle>
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
                        Delete Finding
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ) : null}
        </header>

        <nav
          aria-label="Finding sections"
          className="-mx-4 overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6 @min-[760px]:-mx-8 @min-[760px]:px-8"
        >
          <div className="flex w-max gap-5 py-3 text-xs font-medium text-muted-foreground">
            {[
              ["overview", "Overview"],
              ["reproduce", "Reproduce"],
              ["evidence", "Evidence"],
              ["remediation", "Remediation"],
              ["technical", "Technical"],
            ].map(([id, label]) => (
              <a
                key={id}
                href={`#${sectionId(id)}`}
                className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
              </a>
            ))}
          </div>
        </nav>

        <div className="grid gap-8 pt-6 @min-[760px]:grid-cols-[minmax(0,1fr)_12rem]">
          <div className="min-w-0 space-y-10">
            <section
              id={sectionId("overview")}
              className="scroll-mt-20 space-y-8"
              aria-labelledby={`${sectionId("overview")}-heading`}
            >
              <h3
                id={`${sectionId("overview")}-heading`}
                className="text-base font-semibold text-foreground"
              >
                Overview
              </h3>
              <MarkdownSection title="Summary" value={finding.description} />
              <MarkdownSection title="Impact" value={finding.impact} />
              {finding.code_locations && finding.code_locations.length > 0 && (
                <DetailSection title="Affected Locations">
                  <div className="space-y-2">
                    {finding.code_locations.map((location, index) => (
                      <div
                        key={`${location.file}:${location.start_line}:${index}`}
                        className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/20 p-3"
                      >
                        <Code2
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div
                            className="break-all font-mono text-xs text-foreground"
                            translate="no"
                          >
                            {location.file}:{location.start_line}-
                            {location.end_line}
                          </div>
                          {location.label && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {location.label}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </DetailSection>
              )}
            </section>

            <section
              id={sectionId("reproduce")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("reproduce")}-heading`}
            >
              <h3
                id={`${sectionId("reproduce")}-heading`}
                className="text-base font-semibold text-foreground"
              >
                Reproduce
              </h3>
              <MarkdownSection
                title="Proof of Concept"
                value={finding.poc_description}
              />
              <DetailSection title="PoC Script or Payload">
                <div className="relative max-w-full">
                  <div className="absolute right-1.5 top-1.5">
                    <CopyTextButton
                      value={finding.poc_script_code}
                      label="Copy PoC"
                      successMessage="PoC copied"
                    />
                  </div>
                  <pre className="max-w-full overflow-x-auto rounded-lg border border-border bg-muted/30 p-3 pr-12 text-xs leading-relaxed">
                    <code translate="no">{finding.poc_script_code}</code>
                  </pre>
                </div>
              </DetailSection>
            </section>

            <section
              id={sectionId("evidence")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("evidence")}-heading`}
            >
              <h3
                id={`${sectionId("evidence")}-heading`}
                className="text-base font-semibold text-foreground"
              >
                Evidence
              </h3>
              <MarkdownSection
                title="Observed Evidence"
                value={finding.evidence}
              />
            </section>

            <section
              id={sectionId("remediation")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("remediation")}-heading`}
            >
              <h3
                id={`${sectionId("remediation")}-heading`}
                className="text-base font-semibold text-foreground"
              >
                Remediation
              </h3>
              <MarkdownSection
                title="Recommended Fix"
                value={finding.remediation_steps}
              />

              {finding.code_locations && finding.code_locations.length > 0 && (
                <DetailSection title="Code Changes">
                  <div className="space-y-3">
                    {finding.code_locations.map((location, index) => (
                      <div
                        key={`${location.file}:${location.start_line}:${index}`}
                        className="rounded-lg border border-border bg-muted/20 p-3"
                      >
                        <div
                          className="break-all font-mono text-xs text-foreground"
                          translate="no"
                        >
                          {location.file}:{location.start_line}-
                          {location.end_line}
                        </div>
                        {location.label && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {location.label}
                          </div>
                        )}
                        {location.snippet && (
                          <pre className="mt-3 max-w-full overflow-x-auto rounded-md bg-background p-3 text-xs">
                            <code translate="no">{location.snippet}</code>
                          </pre>
                        )}
                        {location.fix_before && location.fix_after && (
                          <div className="mt-3 grid gap-3 @min-[620px]:grid-cols-2">
                            <div className="min-w-0">
                              <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                                Before
                              </div>
                              <pre className="max-w-full overflow-x-auto rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs">
                                <code translate="no">
                                  {location.fix_before}
                                </code>
                              </pre>
                            </div>
                            <div className="min-w-0">
                              <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                                After
                              </div>
                              <pre className="max-w-full overflow-x-auto rounded-md border border-green-500/20 bg-green-500/5 p-3 text-xs">
                                <code translate="no">{location.fix_after}</code>
                              </pre>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </DetailSection>
              )}
            </section>

            <section
              id={sectionId("technical")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("technical")}-heading`}
            >
              <h3
                id={`${sectionId("technical")}-heading`}
                className="text-base font-semibold text-foreground"
              >
                Technical Details
              </h3>
              <MarkdownSection
                title="Technical Analysis"
                value={finding.technical_analysis}
              />
              <MarkdownSection
                title="Assumptions"
                value={finding.assumptions}
              />
              <DetailSection title="CVSS 3.1 Breakdown">
                <div className="overflow-hidden rounded-lg border border-border bg-muted/20">
                  <dl className="grid grid-cols-1 gap-px bg-border @min-[520px]:grid-cols-2">
                    {CVSS_METRICS.map((metric) => (
                      <div
                        key={metric.key}
                        className="flex items-center justify-between gap-3 bg-background px-3 py-2"
                      >
                        <dt className="text-xs text-muted-foreground">
                          {metric.label}
                        </dt>
                        <dd className="text-xs font-medium text-foreground">
                          {CVSS_VALUE_LABELS[metric.key][
                            finding.cvss_breakdown[metric.key]
                          ] ?? finding.cvss_breakdown[metric.key]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-1.5">
                    <div
                      className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground"
                      translate="no"
                    >
                      {finding.cvss_vector}
                    </div>
                    <CopyTextButton
                      value={finding.cvss_vector}
                      label="Copy CVSS vector"
                      successMessage="CVSS vector copied"
                    />
                  </div>
                </div>
              </DetailSection>
            </section>
          </div>

          <aside className="space-y-5 self-start border-t border-border pt-6 @min-[760px]:sticky @min-[760px]:top-6 @min-[760px]:border-l @min-[760px]:border-t-0 @min-[760px]:pl-6 @min-[760px]:pt-0">
            <dl className="space-y-5">
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Severity
                </dt>
                <dd className="mt-1.5 flex items-center gap-2 text-sm font-medium text-foreground">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      finding.severity === "critical" && "bg-red-500",
                      finding.severity === "high" && "bg-orange-500",
                      finding.severity === "medium" && "bg-yellow-500",
                      finding.severity === "low" && "bg-blue-500",
                      finding.severity === "info" && "bg-slate-500",
                    )}
                    aria-hidden="true"
                  />
                  {formatLabel(finding.severity)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  CVSS
                </dt>
                <dd className="mt-1.5 font-mono text-sm font-medium tabular-nums text-foreground">
                  {finding.cvss_score.toFixed(1)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Fix Effort
                </dt>
                <dd className="mt-1.5 text-sm font-medium text-foreground">
                  {formatLabel(finding.fix_effort)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Validation
                </dt>
                <dd className="mt-1.5 space-y-1.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2
                      className="size-3.5 text-emerald-500"
                      aria-hidden="true"
                    />
                    Working PoC
                  </span>
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2
                      className="size-3.5 text-emerald-500"
                      aria-hidden="true"
                    />
                    Evidence captured
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Discovered
                </dt>
                <dd className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Clock3
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <FindingDiscoveredAt timestamp={finding.created_at} />
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </article>
    </div>
  );
}
