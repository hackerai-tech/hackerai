"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronDown, LoaderCircle } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { EvidenceVerification } from "@/lib/ai/subagents/contracts";

// Shared presentation for Agent assessments (retests and hunt candidates):
// one compact row per assessment that expands into a plain label/value list.

export type OutcomeTone = "red" | "emerald" | "amber" | "hollow";

const DOT: Record<OutcomeTone, string> = {
  red: "bg-red-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  hollow: "border-[1.5px] border-muted-foreground/70",
};

export function OutcomeDot({ tone }: { tone: OutcomeTone }) {
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", DOT[tone])}
      aria-hidden="true"
    />
  );
}

export function OutcomeLabel({
  tone,
  label,
  running,
}: {
  tone: OutcomeTone;
  label: string;
  running?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
      {running ? (
        <LoaderCircle
          className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <OutcomeDot tone={tone} />
      )}
      {label}
    </span>
  );
}

/**
 * A collapsed row: outcome, primary text and an optional trailing meta. The
 * whole trigger is one button; links live only in the expanded details.
 */
export function AssessmentRow({
  outcome,
  primary,
  meta,
  label,
  children,
}: {
  outcome: React.ReactNode;
  primary: React.ReactNode;
  meta?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible asChild>
      <li className="group">
        <CollapsibleTrigger
          aria-label={label}
          className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @min-[640px]:grid-cols-[8rem_minmax(0,1fr)_auto]"
        >
          <span className="flex min-h-5 items-center">{outcome}</span>
          <span className="col-span-2 row-start-2 min-w-0 text-[13px] leading-5 text-foreground @min-[640px]:col-span-1 @min-[640px]:row-start-auto">
            {primary}
          </span>
          <span className="col-start-2 row-start-1 flex min-h-5 items-center gap-3 text-xs text-muted-foreground @min-[640px]:col-start-auto">
            {meta}
            <ChevronDown
              className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pb-5">{children}</CollapsibleContent>
      </li>
    </Collapsible>
  );
}

export function AssessmentList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {children}
    </ul>
  );
}

export type AssessmentField = { label: string; value: React.ReactNode };

/** Plain label/value list; aligns with the row's text column on wide panels. */
export function AssessmentDetails({ fields }: { fields: AssessmentField[] }) {
  return (
    <dl className="space-y-3.5">
      {fields.map((field) => (
        <div
          key={field.label}
          className="grid gap-0.5 @min-[640px]:grid-cols-[8rem_minmax(0,1fr)] @min-[640px]:gap-x-4"
        >
          <dt className="text-[13px] leading-[22px] text-muted-foreground">
            {field.label}
          </dt>
          <dd className="min-w-0 break-words text-sm leading-[22px] text-foreground">
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-1">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-2">
          <span className="w-4 shrink-0 font-mono text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 break-words">{step}</span>
        </li>
      ))}
    </ol>
  );
}

export function TextList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 text-foreground/85">
      {items.map((item, index) => (
        <li key={index} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Evidence paths with their check state. A found file is not a verdict. */
export function EvidenceList({
  refs,
  verification,
}: {
  refs: string[];
  verification?: EvidenceVerification;
}) {
  const checked = new Set(verification?.checked_refs ?? []);
  const items = [
    ...refs.map((ref) => ({
      ref,
      label: checked.has(ref) ? "File found" : "Reference",
    })),
    ...(verification?.unavailable_refs ?? []).map((ref) => ({
      ref,
      label: "Not checked",
    })),
  ];
  return (
    <ul className="space-y-1">
      {items.map(({ ref, label }) => (
        <li
          key={ref}
          className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"
        >
          <span
            className="min-w-0 break-all font-mono text-xs text-foreground"
            translate="no"
          >
            {ref}
          </span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </li>
      ))}
    </ul>
  );
}

export function hasEvidence(
  refs?: string[],
  verification?: EvidenceVerification,
) {
  return (refs?.length ?? 0) + (verification?.unavailable_refs.length ?? 0) > 0;
}

export function TaskLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-8 items-center gap-1 rounded text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowUpRight
        className="size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
    </Link>
  );
}

export const environmentLabel = (environment?: {
  kind: "cloud" | "local" | "desktop";
  name?: string;
}) => {
  if (!environment) return null;
  const kind =
    environment.kind === "cloud"
      ? "Cloud sandbox"
      : environment.kind === "desktop"
        ? "Desktop"
        : "Local sandbox";
  return environment.name ? `${kind} (${environment.name})` : kind;
};
