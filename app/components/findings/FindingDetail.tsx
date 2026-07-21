"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  CheckCircle2,
  Clock3,
  Code2,
  Copy,
  Eye,
  MessageSquareText,
  ShieldAlert,
  ShieldCheck,
  Target,
  Terminal,
  Trash2,
  Wrench,
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

const FindingSectionHeading = ({
  id,
  title,
  description,
  icon,
}: {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}) => (
  <div className="flex items-start gap-3">
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30 text-muted-foreground">
      {icon}
    </div>
    <div className="min-w-0">
      <h3
        id={`${id}-heading`}
        className="text-pretty text-base font-semibold text-foreground"
      >
        {title}
      </h3>
      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  </div>
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
        <header className="space-y-6 border-b border-border pb-8">
          <div className="flex flex-col gap-5 @min-[760px]:flex-row @min-[760px]:items-start @min-[760px]:justify-between">
            <div className="min-w-0 flex-1 space-y-4">
              <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <span className="flex size-6 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10">
                  <ShieldCheck className="size-3.5" aria-hidden="true" />
                </span>
                Confirmed Vulnerability
              </div>

              <h2 className="max-w-4xl text-balance text-2xl font-semibold leading-tight text-foreground @min-[760px]:text-3xl">
                {finding.title}
              </h2>

              <div className="flex flex-wrap items-center gap-2">
                {finding.cwe ? (
                  <span
                    className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground"
                    translate="no"
                  >
                    {finding.cwe}
                  </span>
                ) : null}
                {finding.cve ? (
                  <span
                    className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground"
                    translate="no"
                  >
                    {finding.cve}
                  </span>
                ) : null}
              </div>
            </div>

            {surface === "findings_page" ? (
              <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 @min-[760px]:max-w-64 @min-[760px]:justify-end">
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={getSourceMessageHref(
                      finding.chat_id,
                      finding.message_id,
                    )}
                    aria-label={`Open source message in ${finding.chat_title}`}
                  >
                    <MessageSquareText className="size-4" aria-hidden="true" />
                    Open Source Message
                  </Link>
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isDeleting}
                      className="text-muted-foreground hover:text-destructive"
                    >
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
                <span className="w-full truncate text-xs text-muted-foreground @min-[760px]:text-right">
                  From {finding.chat_title}
                </span>
              </div>
            ) : null}
          </div>

          <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border @min-[520px]:grid-cols-2 @min-[860px]:grid-cols-4">
            <div className="min-w-0 bg-muted/20 p-3.5">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Severity
              </dt>
              <dd className="mt-1.5">
                <span
                  className={cn(
                    "inline-flex rounded-md border px-2 py-1 text-[11px] font-semibold uppercase",
                    getFindingSeverityClasses(finding.severity),
                  )}
                >
                  {formatLabel(finding.severity)}
                </span>
              </dd>
            </div>
            <div className="min-w-0 bg-muted/20 p-3.5">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                CVSS 3.1
              </dt>
              <dd className="mt-1.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                {finding.cvss_score.toFixed(1)}
              </dd>
            </div>
            <div className="min-w-0 bg-muted/20 p-3.5">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Fix Effort
              </dt>
              <dd className="mt-1.5 text-sm font-medium text-foreground">
                {formatLabel(finding.fix_effort)}
              </dd>
            </div>
            <div className="min-w-0 bg-muted/20 p-3.5">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Discovered
              </dt>
              <dd className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                <Clock3
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <FindingDiscoveredAt timestamp={finding.created_at} />
              </dd>
            </div>
          </dl>

          <dl
            className={cn(
              "grid gap-px overflow-hidden rounded-xl border border-border bg-border",
              finding.endpoint && "@min-[600px]:grid-cols-2",
            )}
          >
            <div className="min-w-0 bg-muted/20 p-3.5">
              <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Target className="size-3.5" aria-hidden="true" />
                Target
              </dt>
              <dd
                className="mt-1.5 break-all font-mono text-xs leading-5 text-foreground"
                translate="no"
              >
                {finding.target}
              </dd>
            </div>
            {finding.endpoint ? (
              <div className="min-w-0 bg-muted/20 p-3.5">
                <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Code2 className="size-3.5" aria-hidden="true" />
                  Endpoint
                </dt>
                <dd
                  className="mt-1.5 flex min-w-0 items-start gap-2 font-mono text-xs leading-5 text-foreground"
                  translate="no"
                >
                  {finding.method ? (
                    <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] font-semibold">
                      {finding.method}
                    </span>
                  ) : null}
                  <span className="min-w-0 break-all">{finding.endpoint}</span>
                </dd>
              </div>
            ) : null}
          </dl>
        </header>

        <nav
          aria-label="Finding sections"
          className="sticky top-0 z-10 -mx-4 overflow-x-auto border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:-mx-6 sm:px-6 @min-[760px]:-mx-8 @min-[760px]:px-8"
        >
          <div className="flex w-max gap-1 py-2 text-xs font-medium text-muted-foreground">
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
                className="rounded-md px-3 py-1.5 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
              </a>
            ))}
          </div>
        </nav>

        <div className="pt-8">
          <div className="min-w-0 space-y-12">
            <section
              id={sectionId("overview")}
              className="scroll-mt-20 space-y-8"
              aria-labelledby={`${sectionId("overview")}-heading`}
            >
              <FindingSectionHeading
                id={sectionId("overview")}
                title="Overview"
                description="The validated behavior and its real-world security impact."
                icon={<ShieldCheck className="size-4" aria-hidden="true" />}
              />
              <div className="grid gap-3 @min-[620px]:grid-cols-2">
                <section className="rounded-xl border border-border bg-muted/15 p-4">
                  <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Summary
                  </h4>
                  <div className="mt-3 min-w-0 break-words text-sm leading-6 text-foreground">
                    <MemoizedMarkdown content={finding.description} />
                  </div>
                </section>
                <section
                  className={cn(
                    "rounded-xl border p-4",
                    getFindingSeverityClasses(finding.severity),
                  )}
                >
                  <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide">
                    <ShieldAlert className="size-3.5" aria-hidden="true" />
                    Impact
                  </h4>
                  <div className="mt-3 min-w-0 break-words text-sm leading-6 text-foreground">
                    <MemoizedMarkdown content={finding.impact} />
                  </div>
                </section>
              </div>
            </section>

            <section
              id={sectionId("reproduce")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("reproduce")}-heading`}
            >
              <FindingSectionHeading
                id={sectionId("reproduce")}
                title="Reproduce the Finding"
                description="The repeatable steps and payload used to confirm the vulnerability."
                icon={<Terminal className="size-4" aria-hidden="true" />}
              />
              <MarkdownSection
                title="Proof of Concept"
                value={finding.poc_description}
              />
              <section
                className="overflow-hidden rounded-xl border border-border bg-muted/20"
                aria-labelledby={`${sectionId("reproduce")}-payload-heading`}
              >
                <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                  <h4
                    id={`${sectionId("reproduce")}-payload-heading`}
                    className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    PoC Script or Payload
                  </h4>
                  <div className="shrink-0">
                    <CopyTextButton
                      value={finding.poc_script_code}
                      label="Copy PoC"
                      successMessage="PoC copied"
                    />
                  </div>
                </div>
                <pre className="max-w-full overflow-x-auto p-4 text-xs leading-relaxed">
                  <code translate="no">{finding.poc_script_code}</code>
                </pre>
              </section>
            </section>

            <section
              id={sectionId("evidence")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("evidence")}-heading`}
            >
              <FindingSectionHeading
                id={sectionId("evidence")}
                title="Evidence & Affected Code"
                description="The captured behavior and any source locations tied to the finding."
                icon={<Eye className="size-4" aria-hidden="true" />}
              />
              <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  Evidence Captured
                </h4>
                <div className="mt-3 min-w-0 break-words text-sm leading-6 text-foreground">
                  <MemoizedMarkdown content={finding.evidence} />
                </div>
              </section>
              {finding.code_locations && finding.code_locations.length > 0 ? (
                <DetailSection title="Code Evidence">
                  <div className="space-y-3">
                    {finding.code_locations.map((location, index) => (
                      <section
                        key={`${location.file}:${location.start_line}:${index}`}
                        className="overflow-hidden rounded-xl border border-border bg-muted/10"
                        aria-label={
                          location.label ??
                          `${location.file}:${location.start_line}-${location.end_line}`
                        }
                      >
                        <div className="flex min-w-0 flex-col gap-1 border-b border-border px-4 py-3 @min-[620px]:flex-row @min-[620px]:items-center @min-[620px]:justify-between">
                          <div className="min-w-0">
                            {location.label ? (
                              <div className="text-sm font-medium text-foreground">
                                {location.label}
                              </div>
                            ) : null}
                            <div
                              className="break-all font-mono text-xs text-muted-foreground"
                              translate="no"
                            >
                              {location.file}:{location.start_line}-
                              {location.end_line}
                            </div>
                          </div>
                          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            Source Reference
                          </span>
                        </div>
                        {location.snippet ? (
                          <pre className="max-w-full overflow-x-auto p-4 text-xs leading-relaxed">
                            <code translate="no">{location.snippet}</code>
                          </pre>
                        ) : (
                          <p className="px-4 py-3 text-xs text-muted-foreground">
                            No source snippet was included with this report.
                          </p>
                        )}
                      </section>
                    ))}
                  </div>
                </DetailSection>
              ) : null}
            </section>

            <section
              id={sectionId("remediation")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("remediation")}-heading`}
            >
              <FindingSectionHeading
                id={sectionId("remediation")}
                title="Remediation Guidance"
                description="Recommended changes to remove the root cause and prevent regression."
                icon={<Wrench className="size-4" aria-hidden="true" />}
              />
              <MarkdownSection
                title="Recommended Fix"
                value={finding.remediation_steps}
              />

              {finding.code_locations?.some(
                (location) => location.fix_before && location.fix_after,
              ) ? (
                <DetailSection title="Suggested Code Changes">
                  <div className="space-y-3">
                    {finding.code_locations
                      ?.filter(
                        (location) => location.fix_before && location.fix_after,
                      )
                      .map((location, index) => (
                        <section
                          key={`${location.file}:${location.start_line}:${index}`}
                          className="rounded-xl border border-border bg-muted/10 p-4"
                        >
                          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                            <div
                              className="break-all font-mono text-xs text-foreground"
                              translate="no"
                            >
                              {location.file}:{location.start_line}-
                              {location.end_line}
                            </div>
                            <span className="rounded-md border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              Read-only Guidance
                            </span>
                          </div>
                          <div className="mt-3 grid gap-3 @min-[620px]:grid-cols-2">
                            <div className="min-w-0">
                              <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                                Current Code
                              </div>
                              <pre className="max-w-full overflow-x-auto rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs">
                                <code translate="no">
                                  {location.fix_before}
                                </code>
                              </pre>
                            </div>
                            <div className="min-w-0">
                              <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                                Suggested Change
                              </div>
                              <pre className="max-w-full overflow-x-auto rounded-md border border-green-500/20 bg-green-500/5 p-3 text-xs">
                                <code translate="no">{location.fix_after}</code>
                              </pre>
                            </div>
                          </div>
                        </section>
                      ))}
                  </div>
                </DetailSection>
              ) : null}
            </section>

            <section
              id={sectionId("technical")}
              className="scroll-mt-20 space-y-8 border-t border-border pt-8"
              aria-labelledby={`${sectionId("technical")}-heading`}
            >
              <FindingSectionHeading
                id={sectionId("technical")}
                title="Technical Analysis"
                description="Root-cause analysis, assumptions, and CVSS 3.1 scoring."
                icon={<Code2 className="size-4" aria-hidden="true" />}
              />
              <MarkdownSection
                title="Root Cause"
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
        </div>
      </article>
    </div>
  );
}
