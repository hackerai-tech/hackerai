"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Info,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { AgentRetestOutcome } from "@/lib/findings/agent-retest";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import { cn } from "@/lib/utils";
import type {
  FindingAgentRetestView,
  FindingDetailRecord,
  FindingRetestState,
} from "@/types/finding";
import { useFindingFollowupDraft } from "./FindingFollowupActions";
import { FindingRelativeTime } from "./FindingTime";

const POLL_INTERVAL_MS = 5_000;

type EnabledState = Extract<FindingRetestState, { enabled: true }>;

async function fetchRetestState(
  findingId: string,
): Promise<FindingRetestState | null> {
  try {
    const response = await fetch(
      `/api/finding-retests?findingId=${encodeURIComponent(findingId)}`,
      { cache: "no-store" },
    );
    return response.ok ? ((await response.json()) as FindingRetestState) : null;
  } catch {
    return null;
  }
}

/**
 * Retest history for a finding. `undefined` while loading; a failed first read
 * resolves to disabled so the report keeps its existing follow-up actions.
 * Polls only while a real Agent run is recorded as running.
 */
export function useFindingRetestState(
  findingId: string | undefined,
): FindingRetestState | undefined {
  const [loaded, setLoaded] = useState<{
    findingId: string;
    state: FindingRetestState;
  } | null>(null);
  const readSequence = useRef(0);

  // A failed refresh keeps the last good state for the same finding.
  const read = useCallback((id: string, isCurrent: () => boolean) => {
    const sequence = ++readSequence.current;
    return fetchRetestState(id).then((next) => {
      if (!isCurrent() || sequence !== readSequence.current) return;
      setLoaded((prev) => ({
        findingId: id,
        state:
          next ??
          (prev?.findingId === id ? prev.state : { enabled: false as const }),
      }));
    });
  }, []);

  useEffect(() => {
    if (!findingId) return;
    let current = true;
    void read(findingId, () => current);
    return () => {
      current = false;
    };
  }, [findingId, read]);

  const state =
    loaded && loaded.findingId === findingId ? loaded.state : undefined;
  const running =
    state?.enabled === true &&
    state.retests.some((retest) => retest.status === "running");
  useEffect(() => {
    if (!findingId || !running) return;
    let current = true;
    const timer = setInterval(
      () => void read(findingId, () => current),
      POLL_INTERVAL_MS,
    );
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [findingId, running, read]);

  return state;
}

const OUTCOME_META: Record<
  AgentRetestOutcome,
  { label: string; dot: string; ring: string }
> = {
  reproduced: {
    label: "Reproduced",
    dot: "bg-red-500",
    ring: "shadow-[0_0_0_4px] shadow-red-500/15",
  },
  not_reproduced: {
    label: "Not reproduced",
    dot: "bg-emerald-500",
    ring: "shadow-[0_0_0_4px] shadow-emerald-500/15",
  },
  inconclusive: {
    label: "Inconclusive",
    dot: "bg-amber-500",
    ring: "shadow-[0_0_0_4px] shadow-amber-500/15",
  },
};

const INTERRUPTED_SUMMARY =
  "The Agent run ended before it saved an assessment. This doesn't show the issue is fixed.";

const outcomeOf = (retest: FindingAgentRetestView): AgentRetestOutcome =>
  retest.outcome ?? "inconclusive";

const summaryOf = (retest: FindingAgentRetestView) =>
  retest.interrupted ? INTERRUPTED_SUMMARY : (retest.summary ?? "");

const environmentLabel = (retest: FindingAgentRetestView) => {
  const environment = retest.environment;
  if (!environment) return null;
  const kind =
    environment.kind === "cloud"
      ? "Cloud sandbox"
      : environment.kind === "desktop"
        ? "Desktop"
        : "Local sandbox";
  return environment.name ? `${kind} (${environment.name})` : kind;
};

const sourceHref = (retest: FindingAgentRetestView) =>
  getSourceMessageHref(retest.chat_id, retest.assistant_message_id);

function OutcomeDot({
  outcome,
  large,
}: {
  outcome: AgentRetestOutcome;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full",
        OUTCOME_META[outcome].dot,
        large ? cn("size-2.5", OUTCOME_META[outcome].ring) : "size-2",
      )}
      aria-hidden="true"
    />
  );
}

function CardSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 border-b border-border p-4">
      <h5 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h5>
      {children}
    </div>
  );
}

function EvidenceRefs({ retest }: { retest: FindingAgentRetestView }) {
  const checked = new Set(retest.evidence_verification?.checked_refs ?? []);
  const unavailable = retest.evidence_verification?.unavailable_refs ?? [];
  const refs = [
    ...(retest.evidence_refs ?? []).map((ref) => ({
      ref,
      label: checked.has(ref) ? "File found" : "Reference",
    })),
    ...unavailable.map((ref) => ({ ref, label: "Not checked" })),
  ];
  if (refs.length === 0) return null;
  return (
    <CardSection title="Evidence">
      <ul className="space-y-1.5">
        {refs.map(({ ref, label }) => (
          <li
            key={ref}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs"
          >
            <span
              className="min-w-0 break-all font-mono text-foreground"
              translate="no"
            >
              {ref}
            </span>
            <span className="text-muted-foreground">{label}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-5 text-muted-foreground">
        A found file confirms the capture exists, not that the result is right.
      </p>
    </CardSection>
  );
}

function LatestAssessment({
  retest,
  chatTitle,
}: {
  retest: FindingAgentRetestView;
  chatTitle: string;
}) {
  const outcome = outcomeOf(retest);
  const environment = environmentLabel(retest);
  const steps = retest.reproduction_steps ?? [];
  const limitations = retest.limitations ?? [];
  return (
    <article
      aria-label={`Latest Agent assessment: ${OUTCOME_META[outcome].label}`}
      className="overflow-hidden rounded-xl border border-border bg-muted/10"
    >
      <div className="space-y-2 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <OutcomeDot outcome={outcome} large />
            <span className="text-base font-semibold text-foreground">
              {OUTCOME_META[outcome].label}
            </span>
            <span className="text-xs text-muted-foreground">
              Agent assessment · latest
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            <FindingRelativeTime
              timestamp={retest.finished_at ?? retest.started_at}
            />
            {environment ? ` · ${environment}` : null}
          </span>
        </div>
        <p className="text-sm leading-6 text-foreground @min-[520px]:pl-5">
          {summaryOf(retest)}
        </p>
      </div>

      {steps.length > 0 ? (
        <CardSection title="Steps Agent followed">
          <ol className="space-y-1.5">
            {steps.map((step, index) => (
              <li key={index} className="flex gap-2.5 text-[13px] leading-5">
                <span className="w-4 shrink-0 font-mono text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 break-words text-foreground">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </CardSection>
      ) : null}

      {retest.expected_result || retest.observed_result ? (
        <div className="grid border-b border-border @min-[640px]:grid-cols-2">
          {retest.expected_result ? (
            <div className="space-y-2 border-b border-border p-4 last:border-b-0 @min-[640px]:border-b-0 @min-[640px]:border-r @min-[640px]:last:border-r-0">
              <h5 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Expected if fixed
              </h5>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">
                {retest.expected_result}
              </p>
            </div>
          ) : null}
          {retest.observed_result ? (
            <div className="space-y-2 p-4">
              <h5 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                What Agent observed
              </h5>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">
                {retest.observed_result}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <EvidenceRefs retest={retest} />

      {limitations.length > 0 ? (
        <CardSection title="Limitations">
          <ul className="list-disc space-y-1.5 pl-4 text-[13px] leading-5 text-foreground/80">
            {limitations.map((limitation, index) => (
              <li key={index} className="break-words">
                {limitation}
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-muted/20 px-4 py-3">
        <span className="min-w-0 text-xs text-muted-foreground">
          {retest.interrupted
            ? "Started by Agent in "
            : "Assessed by Agent in "}
          <span className="text-foreground">{chatTitle}</span>
        </span>
        <Link
          href={sourceHref(retest)}
          className="inline-flex items-center gap-1 rounded text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open in task
          <ArrowUpRight
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </Link>
      </div>
    </article>
  );
}

function RunningAssessment({
  retest,
  chatTitle,
}: {
  retest: FindingAgentRetestView;
  chatTitle: string;
}) {
  return (
    <div
      role="status"
      className="overflow-hidden rounded-xl border border-foreground/20 bg-muted/10"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <LoaderCircle
            className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-base font-semibold text-foreground">
              Agent is retesting
            </p>
            <p className="text-xs text-muted-foreground">
              In {chatTitle} · started{" "}
              <FindingRelativeTime timestamp={retest.started_at} />
            </p>
          </div>
        </div>
        <Link
          href={`/c/${encodeURIComponent(retest.chat_id)}`}
          className="inline-flex items-center gap-1 rounded text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Watch in task
          <ArrowUpRight
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </Link>
      </div>
      <p className="px-4 py-3 text-xs leading-5 text-muted-foreground">
        The assessment appears here when Agent saves it. If the run stops first,
        it&apos;s recorded as Inconclusive and earlier results stay.
      </p>
    </div>
  );
}

function History({ retests }: { retests: FindingAgentRetestView[] }) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold text-foreground">
          Retest history
        </h4>
        <span className="text-xs text-muted-foreground">
          Agent assessments · saved as recorded
        </span>
      </div>
      <ul className="overflow-hidden rounded-xl border border-border">
        {retests.map((retest) => {
          const running = retest.status === "running";
          const outcome = outcomeOf(retest);
          return (
            <li
              key={retest.retest_id}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-xs last:border-b-0 @min-[640px]:grid-cols-[8.5rem_minmax(0,1fr)_auto_auto]"
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                {running ? (
                  <>
                    <LoaderCircle
                      className="size-3 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    Running
                  </>
                ) : (
                  <>
                    <OutcomeDot outcome={outcome} />
                    {OUTCOME_META[outcome].label}
                  </>
                )}
              </span>
              <span className="col-span-3 row-start-2 min-w-0 truncate text-muted-foreground @min-[640px]:col-span-1 @min-[640px]:row-start-auto">
                {running ? "Agent is retesting" : summaryOf(retest)}
              </span>
              <span className="whitespace-nowrap text-right tabular-nums text-foreground/80 @min-[640px]:min-w-24">
                <FindingRelativeTime timestamp={retest.started_at} />
              </span>
              <Link
                href={sourceHref(retest)}
                className="rounded text-right font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`View ${running ? "running retest" : OUTCOME_META[outcome].label} in task`}
              >
                View
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Agent retests for a finding. The single CTA prepares an editable request in
 * the source task; nothing runs until the user sends it there. Results are the
 * Agent's own judgment and never change the finding.
 */
export function FindingAgentRetests({
  finding,
  state,
}: {
  finding: FindingDetailRecord;
  state: EnabledState;
}) {
  const { prepare, dialog } = useFindingFollowupDraft(finding);
  const exposed = useRef<string | null>(null);
  const latest = state.retests[0];
  const running = latest?.status === "running";
  const headingId = `${finding.finding_id}-retest-heading`;

  useEffect(() => {
    if (exposed.current === finding.finding_id) return;
    exposed.current = finding.finding_id;
    try {
      captureAuthenticatedEvent("finding_retest_section_viewed", {
        retest_count: state.retests.length,
      });
    } catch {
      // Analytics cannot block the retest workflow.
    }
  }, [finding.finding_id, state.retests.length]);

  return (
    <section
      className="scroll-mt-8 space-y-5 border-b border-border pb-10"
      aria-labelledby={headingId}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 basis-full space-y-1.5 @min-[760px]:basis-0 @min-[760px]:grow">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3
              id={headingId}
              className="text-lg font-semibold text-foreground"
            >
              Retest
            </h3>
            <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              Agent assessment
            </span>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Agent repeats the reproduction in the source task with the access
            you have now, then records what it observed. Results never close or
            edit the finding.
          </p>
        </div>
        <Button
          size="sm"
          className="h-11 w-full @min-[520px]:h-8 @min-[520px]:w-auto"
          disabled={running}
          onClick={() => prepare("retest", { recordRetest: true })}
        >
          {running ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <RotateCcw className="size-4" aria-hidden="true" />
          )}
          {running ? "Retest running…" : "Retest with Agent"}
        </Button>
      </div>

      {!latest ? (
        <div className="rounded-xl border border-dashed border-border p-4">
          <p className="text-sm font-medium text-foreground">No retests yet</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Retest with Agent prepares a request in {state.chat_title}. Nothing
            runs until you send it there.
          </p>
        </div>
      ) : running ? (
        <RunningAssessment retest={latest} chatTitle={state.chat_title} />
      ) : (
        <LatestAssessment retest={latest} chatTitle={state.chat_title} />
      )}

      {latest ? (
        <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            This is Agent&apos;s judgment from one retest, not independent
            certification. Retests never change or close the finding.
          </span>
        </p>
      ) : null}

      {state.retests.length > 1 ? <History retests={state.retests} /> : null}

      <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/10 p-4">
        <LockKeyhole
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="space-y-1 text-xs leading-5 text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">
              Reproduction guidance
            </span>{" "}
            · Agent follows this report&apos;s{" "}
            <a
              href={`#${finding.finding_id}-reproduce-heading`}
              className="rounded font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              reproduction steps
            </a>{" "}
            and reports what it can&apos;t access.
          </p>
          <p>
            It needs working access in the source task. Missing or expired
            access is recorded as Inconclusive, never as fixed.
          </p>
        </div>
      </div>

      {dialog}
    </section>
  );
}
