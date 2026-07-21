"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Copy,
  LockKeyhole,
  MessageSquareText,
  ShieldAlert,
  ShieldCheck,
  Target,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
import { FINDING_CATEGORY_LABELS } from "@/lib/findings/category";
import {
  FINDING_CLOSURE_CONTEXT_MAX,
  FINDING_CLOSURE_REASON_LABELS,
  FINDING_CLOSURE_REASONS,
} from "@/lib/findings/lifecycle";
import type {
  Cvss31Breakdown,
  FindingClosureReason,
  FindingDetailRecord,
} from "@/types/finding";
import { cn } from "@/lib/utils";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import {
  getFindingSeverityClasses,
  getFindingSeverityDotClasses,
} from "./FindingCard";
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
  surface = "detail",
  className,
  onRequestClose,
}: {
  findingId?: string;
  finding?: FindingDetailRecord | null;
  surface?: "computer_sidebar" | "findings_page" | "detail";
  className?: string;
  onRequestClose?: () => void;
}) {
  const queriedFinding = useQuery(
    api.findings.getFinding,
    suppliedFinding !== undefined || !findingId ? "skip" : { findingId },
  ) as FindingDetailRecord | null | undefined;
  const closeFinding = useMutation(api.findings.closeFinding);
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [closureReason, setClosureReason] =
    useState<FindingClosureReason>("already_fixed");
  const [closureContext, setClosureContext] = useState("");
  const [localClosure, setLocalClosure] = useState<
    | Pick<
        FindingDetailRecord,
        "status" | "closure_reason" | "closure_context" | "closed_at"
      >
    | undefined
  >();
  const persistedFinding =
    suppliedFinding !== undefined ? suppliedFinding : queriedFinding;

  if (persistedFinding === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Loading finding…
      </div>
    );
  }

  if (!persistedFinding) {
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

  const finding = localClosure
    ? { ...persistedFinding, ...localClosure }
    : persistedFinding;

  const handleCloseFinding = async () => {
    if (!closureContext.trim()) return;
    setIsClosing(true);
    try {
      const result = await closeFinding({
        findingId: finding.finding_id,
        reason: closureReason,
        context: closureContext,
      });
      if (result.closed) {
        setLocalClosure({
          status: "closed",
          closure_reason: closureReason,
          closure_context: closureContext.trim(),
          closed_at: result.closed_at,
        });
        setIsCloseDialogOpen(false);
        setClosureContext("");
        toast.success("Finding closed");
      } else if (result.already_closed) {
        setIsCloseDialogOpen(false);
        toast.info("This finding is already closed.");
      }
    } catch {
      toast.error("Could not close finding. Try again.");
    } finally {
      setIsClosing(false);
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
      <article className="mx-auto w-full max-w-5xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-7 @min-[760px]:px-10 @min-[760px]:py-9">
        <header className="space-y-7 border-b border-border pb-9">
          {surface === "findings_page" && onRequestClose ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-3 text-muted-foreground hover:text-foreground"
              onClick={onRequestClose}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to Findings
            </Button>
          ) : null}

          <div className="flex flex-col gap-5 @min-[760px]:flex-row @min-[760px]:items-start @min-[760px]:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  Confirmed Vulnerability
                </span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      finding.status === "active"
                        ? "bg-emerald-500"
                        : "bg-muted-foreground/60",
                    )}
                    aria-hidden="true"
                  />
                  {finding.status === "active" ? "Active" : "Closed"}
                </span>
              </div>

              <h2 className="mt-3 max-w-4xl text-balance text-2xl font-semibold leading-tight text-foreground @min-[760px]:text-3xl">
                {finding.title}
              </h2>
            </div>

            {surface === "findings_page" ? (
              <div className="flex min-w-0 shrink-0 flex-col gap-2 @min-[520px]:flex-row @min-[760px]:max-w-sm @min-[760px]:flex-wrap @min-[760px]:justify-end">
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
                {finding.status === "active" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsCloseDialogOpen(true)}
                  >
                    <LockKeyhole className="size-4" aria-hidden="true" />
                    Close Finding
                  </Button>
                ) : null}
                <span className="min-w-0 truncate text-xs text-muted-foreground @min-[520px]:w-full @min-[760px]:text-right">
                  From {finding.chat_title}
                </span>
              </div>
            ) : null}
          </div>

          <dl className="grid gap-x-8 gap-y-6 border-t border-border pt-6 @min-[520px]:grid-cols-2 @min-[880px]:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Severity
              </dt>
              <dd className="mt-2 flex items-center gap-2 text-sm font-medium text-foreground">
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    getFindingSeverityDotClasses(finding.severity),
                  )}
                  aria-hidden="true"
                />
                {formatLabel(finding.severity)}
              </dd>
              <dd className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                CVSS 3.1 · {finding.cvss_score.toFixed(1)}
              </dd>
            </div>

            <div className="min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Category
              </dt>
              <dd className="mt-2 text-sm font-medium text-foreground">
                {FINDING_CATEGORY_LABELS[finding.category]}
              </dd>
              {finding.cwe || finding.cve ? (
                <dd
                  className="mt-1 break-words font-mono text-xs text-muted-foreground"
                  translate="no"
                >
                  {[finding.cwe, finding.cve].filter(Boolean).join(" · ")}
                </dd>
              ) : null}
            </div>

            <div className="min-w-0">
              <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Target className="size-3.5" aria-hidden="true" />
                Affected Target
              </dt>
              <dd
                className="mt-2 break-all font-mono text-xs leading-5 text-foreground"
                translate="no"
              >
                {finding.target}
              </dd>
              {finding.endpoint ? (
                <dd
                  className="mt-1 flex min-w-0 items-start gap-1.5 font-mono text-xs leading-5 text-muted-foreground"
                  translate="no"
                >
                  {finding.method ? (
                    <span className="shrink-0 font-semibold text-foreground">
                      {finding.method}
                    </span>
                  ) : null}
                  <span className="min-w-0 break-all">{finding.endpoint}</span>
                </dd>
              ) : null}
            </div>

            <div className="min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Fix Effort
              </dt>
              <dd className="mt-2 text-sm font-medium text-foreground">
                {formatLabel(finding.fix_effort)}
              </dd>
              <dd className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                <Clock3
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                Found <FindingDiscoveredAt timestamp={finding.created_at} />
              </dd>
            </div>
          </dl>

          {finding.status === "closed" &&
          finding.closure_reason &&
          finding.closure_context ? (
            <section
              className="border-l-2 border-muted-foreground/40 pl-4"
              aria-labelledby={`${finding.finding_id}-closure-heading`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3
                  id={`${finding.finding_id}-closure-heading`}
                  className="flex items-center gap-2 text-sm font-semibold text-foreground"
                >
                  <LockKeyhole
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  Closure Context
                </h3>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-md border border-border bg-background px-2 py-1 font-medium text-foreground">
                    {FINDING_CLOSURE_REASON_LABELS[finding.closure_reason]}
                  </span>
                  {finding.closed_at ? (
                    <span>
                      Closed{" "}
                      <FindingDiscoveredAt timestamp={finding.closed_at} />
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">
                {finding.closure_context}
              </p>
            </section>
          ) : null}
        </header>

        <div className="pt-9">
          <div className="min-w-0 max-w-4xl space-y-10 @min-[760px]:space-y-12">
            <section
              id={sectionId("overview")}
              className="scroll-mt-8 space-y-4 border-b border-border pb-10"
              aria-labelledby={`${sectionId("overview")}-heading`}
            >
              <h3
                id={`${sectionId("overview")}-heading`}
                className="text-pretty text-lg font-semibold text-foreground"
              >
                Summary
              </h3>
              <div className="min-w-0 break-words text-sm leading-7 text-foreground">
                <MemoizedMarkdown content={finding.description} />
              </div>
            </section>

            <section
              className={cn(
                "space-y-4 rounded-r-lg border-l-2 px-4 py-1",
                getFindingSeverityClasses(finding.severity),
              )}
              aria-labelledby={`${sectionId("overview")}-impact-heading`}
            >
              <h3
                id={`${sectionId("overview")}-impact-heading`}
                className="flex items-center gap-2 text-lg font-semibold"
              >
                <ShieldAlert className="size-4" aria-hidden="true" />
                Impact
              </h3>
              <div className="min-w-0 break-words text-sm leading-7 text-foreground">
                <MemoizedMarkdown content={finding.impact} />
              </div>
            </section>

            <section
              id={sectionId("technical")}
              className="scroll-mt-8 space-y-4 border-b border-border pb-10"
              aria-labelledby={`${sectionId("technical")}-heading`}
            >
              <h3
                id={`${sectionId("technical")}-heading`}
                className="text-pretty text-lg font-semibold text-foreground"
              >
                Root Cause
              </h3>
              <div className="min-w-0 break-words text-sm leading-7 text-foreground">
                <MemoizedMarkdown content={finding.technical_analysis} />
              </div>
            </section>

            <section
              id={sectionId("evidence")}
              className="scroll-mt-8 space-y-8 border-b border-border pb-10"
              aria-labelledby={`${sectionId("evidence")}-heading`}
            >
              <div className="space-y-1.5">
                <h3
                  id={`${sectionId("evidence")}-heading`}
                  className="text-pretty text-lg font-semibold text-foreground"
                >
                  Validation
                </h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  Reproduction steps, observed evidence, and affected locations
                  used to confirm this vulnerability.
                </p>
              </div>

              <section
                className="border-l-2 border-emerald-500/60 pl-4"
                aria-labelledby={`${sectionId("evidence")}-captured-heading`}
              >
                <h4
                  id={`${sectionId("evidence")}-captured-heading`}
                  className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400"
                >
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                  Observed Evidence
                </h4>
                <div className="mt-3 min-w-0 break-words text-sm leading-7 text-foreground">
                  <MemoizedMarkdown content={finding.evidence} />
                </div>
              </section>

              <MarkdownSection
                id={sectionId("reproduce")}
                title="Reproduction"
                value={finding.poc_description}
              />

              <section
                className="overflow-hidden rounded-xl border border-border bg-muted/15"
                aria-labelledby={`${sectionId("reproduce")}-payload-heading`}
              >
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
                  <h4
                    id={`${sectionId("reproduce")}-payload-heading`}
                    className="text-sm font-semibold text-foreground"
                  >
                    PoC Script or Payload
                  </h4>
                  <CopyTextButton
                    value={finding.poc_script_code}
                    label="Copy PoC"
                    successMessage="PoC copied"
                  />
                </div>
                <pre className="max-w-full overflow-x-auto p-4 text-xs leading-relaxed">
                  <code translate="no">{finding.poc_script_code}</code>
                </pre>
              </section>

              {finding.code_locations && finding.code_locations.length > 0 ? (
                <DetailSection title="Affected Locations">
                  <div className="space-y-4">
                    {finding.code_locations.map((location, index) => (
                      <section
                        key={`${location.file}:${location.start_line}:${index}`}
                        className="overflow-hidden rounded-xl border border-border"
                        aria-label={
                          location.label ??
                          `${location.file}:${location.start_line}-${location.end_line}`
                        }
                      >
                        <div className="flex min-w-0 flex-col gap-1 px-4 py-3 @min-[620px]:flex-row @min-[620px]:items-start @min-[620px]:justify-between">
                          <div className="min-w-0">
                            {location.label ? (
                              <div className="text-sm font-medium text-foreground">
                                {location.label}
                              </div>
                            ) : null}
                            <div
                              className="mt-0.5 break-all font-mono text-xs text-muted-foreground"
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
                          <pre className="max-w-full overflow-x-auto border-t border-border bg-muted/15 p-4 text-xs leading-relaxed">
                            <code translate="no">{location.snippet}</code>
                          </pre>
                        ) : (
                          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
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
              className="scroll-mt-8 space-y-8 border-b border-border pb-10"
              aria-labelledby={`${sectionId("remediation")}-heading`}
            >
              <div className="space-y-1.5">
                <h3
                  id={`${sectionId("remediation")}-heading`}
                  className="text-pretty text-lg font-semibold text-foreground"
                >
                  Remediation
                </h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  Recommended changes to remove the root cause and prevent
                  regression.
                </p>
              </div>

              <div className="min-w-0 break-words text-sm leading-7 text-foreground">
                <MemoizedMarkdown content={finding.remediation_steps} />
              </div>

              {finding.code_locations?.some(
                (location) => location.fix_before && location.fix_after,
              ) ? (
                <DetailSection title="Suggested Code Changes">
                  <div className="space-y-4">
                    {finding.code_locations
                      ?.filter(
                        (location) => location.fix_before && location.fix_after,
                      )
                      .map((location, index) => (
                        <section
                          key={`${location.file}:${location.start_line}:${index}`}
                          className="rounded-xl border border-border p-4"
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
                          <div className="mt-4 grid gap-4 @min-[620px]:grid-cols-2">
                            <div className="min-w-0">
                              <div className="mb-1.5 text-[11px] font-medium uppercase text-muted-foreground">
                                Current Code
                              </div>
                              <pre className="max-w-full overflow-x-auto rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs">
                                <code translate="no">
                                  {location.fix_before}
                                </code>
                              </pre>
                            </div>
                            <div className="min-w-0">
                              <div className="mb-1.5 text-[11px] font-medium uppercase text-muted-foreground">
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
              className="space-y-8 pb-4"
              aria-labelledby={`${sectionId("assessment")}-heading`}
            >
              <div className="space-y-1.5">
                <h3
                  id={`${sectionId("assessment")}-heading`}
                  className="text-pretty text-lg font-semibold text-foreground"
                >
                  Assessment Details
                </h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  Assumptions and the server-calculated CVSS 3.1 score.
                </p>
              </div>

              <MarkdownSection
                title="Assumptions"
                value={finding.assumptions}
              />

              <DetailSection title="CVSS 3.1 Breakdown">
                <div className="overflow-hidden rounded-lg border border-border">
                  <dl className="grid grid-cols-1 divide-y divide-border @min-[520px]:grid-cols-2 @min-[520px]:divide-x @min-[520px]:divide-y-0">
                    {CVSS_METRICS.map((metric) => (
                      <div
                        key={metric.key}
                        className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0 @min-[520px]:[&:nth-last-child(-n+2)]:border-b-0"
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

      {surface === "findings_page" ? (
        <Dialog
          open={isCloseDialogOpen}
          onOpenChange={(open) => {
            if (!isClosing) setIsCloseDialogOpen(open);
          }}
        >
          <DialogContent
            showCloseButton={!isClosing}
            overlayClassName="bg-black/60 backdrop-blur-sm"
            className="max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain p-4 sm:max-w-xl sm:p-6"
          >
            <form
              className="space-y-5 sm:space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCloseFinding();
              }}
            >
              <DialogHeader className="pr-8 text-left">
                <DialogTitle>Close finding</DialogTitle>
                <DialogDescription>
                  Choose a reason and leave a note for future reference. You can
                  still view the report and source message.
                </DialogDescription>
              </DialogHeader>

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium text-foreground">
                  Why are you closing it?
                </legend>
                <RadioGroup
                  value={closureReason}
                  onValueChange={(value) =>
                    setClosureReason(value as FindingClosureReason)
                  }
                  className="grid gap-2 sm:grid-cols-3"
                >
                  {FINDING_CLOSURE_REASONS.map((reason) => (
                    <label
                      key={reason}
                      htmlFor={`finding-closure-${reason}`}
                      className={cn(
                        "flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        closureReason === reason
                          ? "border-foreground/50 bg-muted/50 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                      )}
                    >
                      <RadioGroupItem
                        id={`finding-closure-${reason}`}
                        value={reason}
                        aria-label={FINDING_CLOSURE_REASON_LABELS[reason]}
                      />
                      <span className="min-w-0 text-sm font-medium">
                        {FINDING_CLOSURE_REASON_LABELS[reason]}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>

              <div className="space-y-2">
                <label
                  htmlFor="finding-closure-context"
                  className="text-sm font-medium text-foreground"
                >
                  Closure note
                  <span className="ml-1 font-normal text-muted-foreground">
                    (required)
                  </span>
                </label>
                <Textarea
                  id="finding-closure-context"
                  name="finding-closure-context"
                  autoComplete="off"
                  value={closureContext}
                  onChange={(event) => setClosureContext(event.target.value)}
                  placeholder="Describe what changed, how it was verified, or why it is being closed…"
                  maxLength={FINDING_CLOSURE_CONTEXT_MAX}
                  rows={4}
                  className="min-h-28 resize-y sm:min-h-32"
                  required
                />
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Add enough detail for your future self.</span>
                  <span className="tabular-nums">
                    {closureContext.length}/{FINDING_CLOSURE_CONTEXT_MAX}
                  </span>
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isClosing}
                  onClick={() => setIsCloseDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isClosing || !closureContext.trim()}
                >
                  {isClosing ? "Closing…" : "Close finding"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
